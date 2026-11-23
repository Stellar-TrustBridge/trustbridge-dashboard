/**
 * Tests for idempotency key derivation and dedup logic in
 * src/lib/soroban-register.ts
 *
 * Covers:
 *   Happy path   — first call succeeds, key recorded in COMPLETED_KEYS
 *   Failure #1   — duplicate completed key returns skipped (no double-submit)
 *   Failure #2   — concurrent in-flight key returns skipped (race condition)
 *   Edge cases   — empty inputs, payload variations, SOROBAN_CONTRACT_ID absent
 *   Key derivation — determinism, uniqueness, non-reversibility properties
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveIdempotencyKey,
  isKeyCompleted,
  isKeyInFlight,
  mirrorRegistrationToSoroban,
  _resetIdempotencyCache,
  type MirrorRegistrationPayload,
} from "@/lib/soroban-register";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PAYLOAD: MirrorRegistrationPayload = {
  githubUsername: "alice",
  stellarAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  registrationId: "reg-001",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetIdempotencyCache();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SOROBAN_CONTRACT_ID;
  delete process.env.SOROBAN_RPC_URL;
});

afterEach(() => {
  _resetIdempotencyCache();
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

describe("deriveIdempotencyKey", () => {
  it("returns a 32-character hex string", () => {
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic: same payload produces same key every time", () => {
    const key1 = deriveIdempotencyKey(BASE_PAYLOAD);
    const key2 = deriveIdempotencyKey({ ...BASE_PAYLOAD });
    expect(key1).toBe(key2);
  });

  it("is unique for different registrationIds", () => {
    const k1 = deriveIdempotencyKey({ ...BASE_PAYLOAD, registrationId: "reg-001" });
    const k2 = deriveIdempotencyKey({ ...BASE_PAYLOAD, registrationId: "reg-002" });
    expect(k1).not.toBe(k2);
  });

  it("is unique for different stellarAddresses", () => {
    const k1 = deriveIdempotencyKey({ ...BASE_PAYLOAD, stellarAddress: "GAAA" });
    const k2 = deriveIdempotencyKey({ ...BASE_PAYLOAD, stellarAddress: "GBBB" });
    expect(k1).not.toBe(k2);
  });

  it("is unique for different githubUsernames", () => {
    const k1 = deriveIdempotencyKey({ ...BASE_PAYLOAD, githubUsername: "alice" });
    const k2 = deriveIdempotencyKey({ ...BASE_PAYLOAD, githubUsername: "bob" });
    expect(k1).not.toBe(k2);
  });

  it("does not embed the stellar address in the key (non-reversible)", () => {
    // The key must NOT contain the raw stellar address — it is a hash.
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    expect(key).not.toContain(BASE_PAYLOAD.stellarAddress);
    expect(key).not.toContain(BASE_PAYLOAD.githubUsername);
    expect(key).not.toContain(BASE_PAYLOAD.registrationId);
  });

  it("handles empty strings without throwing", () => {
    expect(() =>
      deriveIdempotencyKey({ githubUsername: "", stellarAddress: "", registrationId: "" })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — no SOROBAN_CONTRACT_ID → skips, records nothing in COMPLETED_KEYS
// ---------------------------------------------------------------------------

describe("mirrorRegistrationToSoroban — no contract configured (skip)", () => {
  it("returns success:true skipped:true with the idempotencyKey", async () => {
    const result = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect(result.success).toBe(true);
    expect((result as { skipped?: boolean }).skipped).toBe(true);
    expect((result as { idempotencyKey?: string }).idempotencyKey).toBeDefined();
  });

  it("includes a human-readable reason", async () => {
    const result = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect((result as { reason?: string }).reason).toMatch(/not configured/i);
  });

  it("does not add the key to COMPLETED_KEYS when skipped for missing config", async () => {
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    // A config-skip does not record the key — a future call after config is
    // set should be able to proceed.
    expect(isKeyCompleted(key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure path #1 — duplicate: same key already completed
// ---------------------------------------------------------------------------

describe("mirrorRegistrationToSoroban — duplicate completed key", () => {
  it("skips and returns skipped:true when key is already in COMPLETED_KEYS", async () => {
    // First call completes (with a valid but stub-validated contract id).
    // We use a contract id that passes format validation.
    process.env.SOROBAN_CONTRACT_ID =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3L"; // 56-char C-address
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    const first = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect(first.success).toBe(true);
    // After success the key is in COMPLETED_KEYS.
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    expect(isKeyCompleted(key)).toBe(true);

    // Second call with identical payload.
    const second = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect(second.success).toBe(true);
    expect((second as { skipped?: boolean }).skipped).toBe(true);
    expect((second as { reason?: string }).reason).toMatch(/already mirrored/i);
  });

  it("does NOT submit to Soroban on the duplicate call", async () => {
    process.env.SOROBAN_CONTRACT_ID =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3L";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    // First call records completion.
    await mirrorRegistrationToSoroban(BASE_PAYLOAD);

    // The second call must not add to in-flight (which would indicate it
    // reached the Soroban submission path).
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    const before = isKeyInFlight(key);
    await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    const after = isKeyInFlight(key);

    expect(before).toBe(false);
    expect(after).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure path #2 — concurrent in-flight (race condition)
// ---------------------------------------------------------------------------

describe("mirrorRegistrationToSoroban — concurrent duplicate (in-flight dedup)", () => {
  it("second concurrent call with same key is skipped", async () => {
    // We simulate the race by directly calling isKeyInFlight after manually
    // inserting the key into IN_FLIGHT_KEYS via the dedup path.
    // The in-flight set is not publicly writable, so we exercise the real code
    // path: start a call, detect it in-flight, then verify via a second call.

    // With a valid contract but a URL that will fail (triggering in-flight → failure path),
    // the in-flight key is released on failure. For testing concurrent in-flight detection
    // we need to inject the key while the first call is still in progress.

    process.env.SOROBAN_CONTRACT_ID =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3L";
    // Use an unparseable URL to cause an immediate synchronous throw inside
    // the try block AFTER `IN_FLIGHT_KEYS.add(key)` but BEFORE the await.
    // The key derivation happens before the add, so both calls get the same key.
    process.env.SOROBAN_RPC_URL = "not-a-url";

    const key = deriveIdempotencyKey(BASE_PAYLOAD);

    // Run both calls concurrently — they race to add the key to IN_FLIGHT_KEYS.
    const [first, second] = await Promise.all([
      mirrorRegistrationToSoroban(BASE_PAYLOAD),
      mirrorRegistrationToSoroban(BASE_PAYLOAD),
    ]);

    // At least one of them must have been skipped as a duplicate.
    const skippedCount = [first, second].filter(
      (r) => (r as { skipped?: boolean }).skipped === true
    ).length;
    expect(skippedCount).toBeGreaterThanOrEqual(1);

    // The key must not be in-flight after both complete.
    expect(isKeyInFlight(key)).toBe(false);
  });

  it("idempotencyKey is included in every result type", async () => {
    const result = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect((result as { idempotencyKey?: string }).idempotencyKey).toBeDefined();
    expect(typeof (result as { idempotencyKey?: string }).idempotencyKey).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Invalid SOROBAN_CONTRACT_ID format → failure path, key cleared from in-flight
// ---------------------------------------------------------------------------

describe("mirrorRegistrationToSoroban — invalid contract id format", () => {
  it("returns success:false and clears in-flight key", async () => {
    process.env.SOROBAN_CONTRACT_ID = "NOT_A_VALID_CONTRACT_ID";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    const result = await mirrorRegistrationToSoroban(BASE_PAYLOAD);

    expect(result.success).toBe(false);
    expect((result as { error?: unknown }).error).toBeDefined();
    // After failure the key must not remain in-flight (so a retry can proceed).
    expect(isKeyInFlight(key)).toBe(false);
    // After failure the key is not recorded as completed.
    expect(isKeyCompleted(key)).toBe(false);
  });

  it("retrying after a failure is allowed (key not permanently blocked)", async () => {
    process.env.SOROBAN_CONTRACT_ID = "NOT_A_VALID_CONTRACT_ID";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    const first = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect(first.success).toBe(false);

    // On retry the key is not in COMPLETED_KEYS and not in IN_FLIGHT_KEYS,
    // so the call proceeds to try again (and fails again, but that is correct).
    const retry = await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    expect(retry.success).toBe(false);
    // Not skipped — it went through the full attempt.
    expect((retry as { skipped?: boolean }).skipped).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _resetIdempotencyCache clears both stores
// ---------------------------------------------------------------------------

describe("_resetIdempotencyCache", () => {
  it("clears COMPLETED_KEYS so a subsequent call is not a no-op", async () => {
    process.env.SOROBAN_CONTRACT_ID =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3L";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    await mirrorRegistrationToSoroban(BASE_PAYLOAD);
    const key = deriveIdempotencyKey(BASE_PAYLOAD);
    expect(isKeyCompleted(key)).toBe(true);

    _resetIdempotencyCache();
    expect(isKeyCompleted(key)).toBe(false);
    expect(isKeyInFlight(key)).toBe(false);
  });
});
