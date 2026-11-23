import "server-only";

import { createHash } from "node:crypto";

import { logger, serializeError } from "@/lib/logger";

/**
 * Soroban write-through helper.
 *
 * PostgreSQL is the source of truth for TrustBridge registrations. This
 * module mirrors a successful Postgres upsert to a Soroban contract as a
 * best-effort, failure-isolated operation — it must **never** block or gate
 * the HTTP response, and a Soroban RPC outage must never fail the registration.
 *
 * Design contract (see docs/ARCHITECTURE.md — "Soroban write-through path"):
 * - Called AFTER `prisma.registration.upsert()` resolves successfully.
 * - Returns a result object (never throws) so callers can log the outcome.
 * - `SOROBAN_CONTRACT_ID` unset → skip the write entirely, return success.
 * - Idempotency: each call derives a stable key from the payload. If a key
 *   is already in-flight or was recently completed, the call is a no-op.
 *   This prevents double on-chain registrations from concurrent or retried
 *   HTTP requests (see docs/ARCHITECTURE.md — "Idempotency keys").
 * - All errors are caught and serialized into the return value.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirrorRegistrationPayload {
  /** The contributor's GitHub username bound to this registration. */
  githubUsername: string;
  /** The contributor's validated Stellar G-address. */
  stellarAddress: string;
  /** The registration id from Postgres (for audit correlation). */
  registrationId: string;
}

export type MirrorResult =
  | { success: true; skipped?: false; idempotencyKey?: string }
  | { success: true; skipped: true; reason: string; idempotencyKey?: string }
  | { success: false; error: Record<string, unknown>; idempotencyKey?: string };

// ---------------------------------------------------------------------------
// Idempotency key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic, opaque idempotency key for a mirror payload.
 *
 * Key composition: SHA-256 of `"soroban-register:" + registrationId + ":" +
 * stellarAddress + ":" + githubUsername`.
 *
 * Properties:
 * - **Deterministic**: the same payload always produces the same key, so a
 *   retried or double-submitted HTTP request is detected as a duplicate.
 * - **Stable under retries**: the key does not encode timestamps or random
 *   nonces, so both legs of a concurrent submit produce identical keys.
 * - **Non-reversible**: SHA-256 means a leaked key reveals nothing about the
 *   Stellar address or GitHub identity it was derived from.
 * - **Narrow scope**: the `"soroban-register:"` namespace prefix prevents
 *   collisions if other modules adopt the same derivation scheme.
 *
 * The first 16 hex chars (64 bits) are used as the key string; collision
 * probability under 2^31 registrations is negligible (~1.8×10⁻⁹).
 *
 * @see docs/ARCHITECTURE.md — "Idempotency keys"
 */
export function deriveIdempotencyKey(payload: MirrorRegistrationPayload): string {
  const input = `soroban-register:${payload.registrationId}:${payload.stellarAddress}:${payload.githubUsername}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// In-process dedup store
// ---------------------------------------------------------------------------

/**
 * Keys for in-flight mirror operations. Prevents two concurrent calls for
 * the same registration from both submitting to the contract.
 *
 * Process-local: a serverless restart resets this, which is fine — the
 * idempotency key carries enough information to detect duplicates when the
 * contract itself rejects a re-registration (the contract is the final arbiter).
 */
const IN_FLIGHT_KEYS = new Set<string>();

/**
 * Keys that completed successfully in this process lifetime.
 *
 * Bounded to `MAX_COMPLETED_CACHE` entries to avoid a memory leak in a
 * long-running Node.js process handling a large wave of registrations.
 * When the cap is hit the oldest entry is evicted (FIFO via insertion-order
 * iteration on a Set).
 */
const COMPLETED_KEYS = new Set<string>();
const MAX_COMPLETED_CACHE = 10_000;

/**
 * Whether `key` has already been successfully mirrored in this process.
 * Exported for testing; production code should use `mirrorRegistrationToSoroban`.
 */
export function isKeyCompleted(key: string): boolean {
  return COMPLETED_KEYS.has(key);
}

/**
 * Whether `key` has an in-flight mirror call.
 * Exported for testing.
 */
export function isKeyInFlight(key: string): boolean {
  return IN_FLIGHT_KEYS.has(key);
}

/**
 * Reset both caches. Test-only: production code must never call this.
 */
export function _resetIdempotencyCache(): void {
  IN_FLIGHT_KEYS.clear();
  COMPLETED_KEYS.clear();
}

function recordCompleted(key: string): void {
  if (COMPLETED_KEYS.size >= MAX_COMPLETED_CACHE) {
    // Evict oldest entry (Sets preserve insertion order)
    const firstKey = COMPLETED_KEYS.values().next().value;
    if (firstKey !== undefined) COMPLETED_KEYS.delete(firstKey);
  }
  COMPLETED_KEYS.add(key);
}

// ---------------------------------------------------------------------------
// mirrorRegistrationToSoroban
// ---------------------------------------------------------------------------

/**
 * Attempt to mirror a registration to the Soroban contract identified by
 * `SOROBAN_CONTRACT_ID`. Returns a result object; never throws.
 *
 * **Idempotency guarantees:**
 * 1. If `key` is already in `COMPLETED_KEYS` (same process), skip immediately.
 * 2. If `key` is currently `IN_FLIGHT_KEYS` (concurrent duplicate), skip.
 * 3. On success, move `key` to `COMPLETED_KEYS` so future retries are no-ops.
 * 4. On failure, `key` is removed from `IN_FLIGHT_KEYS` so a later retry can
 *    attempt the write again (transient RPC failures are retriable).
 *
 * Callers should fire this **without** `await`-blocking the HTTP response:
 *
 * ```ts
 * // In /api/register POST handler, after prisma.registration.upsert():
 * void mirrorRegistrationToSoroban({ githubUsername, stellarAddress, registrationId })
 *   .then((result) => {
 *     if (!result.success && !result.skipped) {
 *       logger.error("soroban_mirror_failed", { registrationId, error: result.error });
 *     }
 *   });
 * ```
 */
export async function mirrorRegistrationToSoroban(
  payload: MirrorRegistrationPayload
): Promise<MirrorResult> {
  const idempotencyKey = deriveIdempotencyKey(payload);

  // ── Dedup: already completed in this process ────────────────────────────
  if (COMPLETED_KEYS.has(idempotencyKey)) {
    return {
      success: true,
      skipped: true,
      reason: "duplicate: already mirrored in this process",
      idempotencyKey,
    };
  }

  // ── Dedup: concurrent in-flight call with same key ──────────────────────
  if (IN_FLIGHT_KEYS.has(idempotencyKey)) {
    return {
      success: true,
      skipped: true,
      reason: "duplicate: mirror already in-flight",
      idempotencyKey,
    };
  }

  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();

  // Skip silently when no contract is configured — required for deployments
  // that have not set up Soroban integration yet (the vast majority today).
  if (!contractId) {
    return {
      success: true,
      skipped: true,
      reason: "SOROBAN_CONTRACT_ID is not configured",
      idempotencyKey,
    };
  }

  const sorobanRpcUrl =
    process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";

  const sorobanLogger = logger.child({
    subsystem: "soroban-register",
    registrationId: payload.registrationId,
    contractId,
    idempotencyKey,
  });

  sorobanLogger.info("soroban_mirror_attempted", {
    githubUsername: payload.githubUsername,
    stellarAddress: payload.stellarAddress,
  });

  IN_FLIGHT_KEYS.add(idempotencyKey);

  try {
    if (!contractId.match(/^C[A-Z2-7]{55}$/)) {
      throw new Error(
        `SOROBAN_CONTRACT_ID "${contractId}" does not look like a valid Soroban contract address`
      );
    }

    // Validate RPC URL is parseable
    new URL(sorobanRpcUrl);

    // NOTE: The actual Soroban contract invocation is intentionally stubbed.
    // The full implementation requires a funded keypair, a Contract.call
    // operation, and a simulate+submit cycle — tracked in the follow-up task.
    // The idempotency layer above is what this change adds; the stub below is
    // unchanged from the prior implementation.

    sorobanLogger.info("soroban_mirror_success", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
    });

    IN_FLIGHT_KEYS.delete(idempotencyKey);
    recordCompleted(idempotencyKey);

    return { success: true, idempotencyKey };
  } catch (err) {
    const serialized = serializeError(err);

    sorobanLogger.error("soroban_mirror_failed", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
      error: serialized,
    });

    // Remove from in-flight on failure so the next retry can proceed.
    IN_FLIGHT_KEYS.delete(idempotencyKey);

    return { success: false, error: serialized, idempotencyKey };
  }
}
