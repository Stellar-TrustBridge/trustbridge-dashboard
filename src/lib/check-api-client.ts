import type { HorizonCheckResult } from "@/types";

/**
 * Client-side wrapper around `POST /api/check`.
 *
 * The route itself already encodes several distinct outcomes (see
 * `src/app/api/check/route.ts`), but they arrive over the wire in
 * inconsistent shapes:
 *  - Rate limiting is a genuine HTTP 429 with a `Retry-After` header.
 *  - A circuit-breaker-open / transient Horizon failure is still HTTP 200,
 *    with a normal `HorizonCheckResult` body whose `errors` array contains a
 *    recognizable string (`"...temporarily unavailable..."` or a
 *    `"Horizon error: ..."` prefix). There is no dedicated status code or
 *    field for this today, and changing that is out of scope for this
 *    change — we only need to recognize the existing convention.
 *  - Anything else non-2xx is a generic error.
 *  - The request itself can hang (Horizon retries/circuit breaker can sit
 *    for a while), so this wrapper applies its own 10 s timeout via an
 *    `AbortController` and also relays a caller-provided AbortSignal.
 *
 * This helper normalizes all of that into a single discriminated union so
 * UI code can `switch` on `outcome.kind` instead of re-deriving these rules.
 *
 * Retries: transient failures (timeout, network error, circuit-open, and
 * 429/5xx responses) are retried a bounded number of times. Every attempt
 * carries the same `Idempotency-Key` for correlation, but `/api/check` is a
 * read-only Horizon check and does not dedupe requests on that header.

 * for a single logical check reuses the same `Idempotency-Key` header so the
 * server can dedupe side effects (e.g. recheck notifications) and a retried
 * request never double-applies them.
 *
 * Circuit-breaker isolation: the dashboard talks to two independent
 * dependencies — Horizon (contributor checks, via `/api/check`) and Soroban
 * (contract sync, via `src/lib/contract-sync.ts`). Each dependency owns its
 * own breaker key (`horizon` vs `soroban`), so a Soroban outage must never
 * open the Horizon circuit and vice versa. This module only ever observes
 * the Horizon breaker; it must not treat a Soroban-side failure as a
 * Horizon circuit-open signal. See `docs/ARCHITECTURE.md` for the topology.
 *
 * Schema version negotiation: successful `/api/check` payloads carry a
 * `schema_version` string (e.g. `"1.0"`). This client accepts any payload
 * whose major version is in `SUPPORTED_CHECK_SCHEMA_MAJORS` and fails closed
 * on anything else (missing, malformed, or unsupported major) with the stable
 * reason code `unsupported_schema_version`. See `docs/ARCHITECTURE.md` and
 * `docs/BREAKING_CHANGES.md`.
 */

/** How long to wait for `/api/check` before treating the request as timed out. */
export const CHECK_TIMEOUT_MS = 10_000;

/** Maximum number of attempts (initial + retries) for a single check. */
export const CHECK_MAX_ATTEMPTS = 3;

/** Base backoff between retries, in milliseconds (exponential). */
export const CHECK_RETRY_BASE_MS = 250;

/**
 * Circuit-breaker key for the Horizon dependency. Kept distinct from the
 * Soroban key (`SOROBAN_CIRCUIT_KEY` in `src/lib/contract-sync.ts`) so the
 * two breakers are isolated and one outage cannot open the other's circuit.
 */
export const HORIZON_CIRCUIT_KEY = "horizon";

/**
 * Check response schema major versions this client understands. A payload
 * whose major is not listed here is rejected (fail closed) rather than being
 * interpreted with a possibly-incompatible shape.
 */
export const SUPPORTED_CHECK_SCHEMA_MAJORS: readonly number[] = [1];

/** Stable reason code emitted when a payload's schema version is unusable. */
export const CHECK_REASON_UNSUPPORTED_SCHEMA_VERSION =
  "unsupported_schema_version";

/** Stable reason code emitted when a payload is empty or not valid JSON. */
export const CHECK_REASON_MALFORMED_PAYLOAD = "malformed_payload";

/** Stable reason code emitted when a payload exceeds the size budget. */
export const CHECK_REASON_PAYLOAD_TOO_LARGE = "payload_too_large";

/** Maximum accepted response body size, in bytes, before failing closed. */
export const CHECK_MAX_PAYLOAD_BYTES = 1_000_000;

export type CheckOutcome =
  | { kind: "ok"; result: HorizonCheckResult }
  | { kind: "rate_limited"; retryAfterSeconds: number | null; errors: string[] }
  | { kind: "circuit_open"; errors: string[] }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network_error" }
  | {
      kind: "schema_error";
      reason: string;
      errors: string[];
    }
  | { kind: "error"; status: number; errors: string[] };

/**
 * Parse a `schema_version` string into its major number. Returns `null` when
 * the value is missing, not a string, or not of the form `<major>[.<minor>]`
 * with a non-negative integer major.
 */
export function parseSchemaMajor(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)(?:\.\d+)*$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

/**
 * True when a payload's `schema_version` has a major this client supports.
 */
export function isSupportedSchemaVersion(version: unknown): boolean {
  const major = parseSchemaMajor(version);
  return major !== null && SUPPORTED_CHECK_SCHEMA_MAJORS.includes(major);
}

/**
 * True when a successful (HTTP 200) `HorizonCheckResult`'s `errors` match the
 * known transient-Horizon-failure conventions emitted by `src/lib/horizon.ts`
 * (circuit breaker open, or a generic wrapped Horizon error).
 *
 * Only Horizon-specific markers are recognized here. Soroban failures use a
 * different prefix (`Soroban error:`) and must not be classified as a
 * Horizon circuit-open, preserving breaker isolation.
 */
function isTransientHorizonError(errors: string[] | undefined): boolean {
  if (!errors || errors.length === 0) return false;
  return errors.some(
    (error) =>
      error.includes("temporarily unavailable") ||
      error.startsWith("Horizon error:")
  );
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Generate a stable correlation key for a single logical check. Uses
 * `crypto.randomUUID` when available and falls back to a random string. The
 * header is informational only — `/api/check` does not dedupe on it.
 */
function createIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `check-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when an outcome represents a transient failure worth retrying. A
 * `rate_limited` outcome is retried only when the server did not ask us to
 * wait longer than our bounded backoff budget. Schema errors are terminal —
 * retrying an incompatible payload cannot succeed.
 */
function isRetryable(outcome: CheckOutcome): boolean {
  switch (outcome.kind) {
    case "aborted":
      return false;
    case "schema_error":
      return false;
    case "timeout":
    case "network_error":
    case "circuit_open":
      return true;
    case "error":
      return outcome.status >= 500;
    case "rate_limited":
      return true;
    default:
      return false;
  }
}

/**
 * Read and validate a successful `/api/check` body. Fails closed on empty,
 * oversized, malformed, or unsupported-major payloads with stable reason
 * codes so callers never silently accept an incompatible shape.
 */
async function readCheckPayload(
  response: Response
): Promise<CheckOutcome> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > CHECK_MAX_PAYLOAD_BYTES) {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_PAYLOAD_TOO_LARGE,
      errors: ["Check response exceeded the maximum accepted size."],
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_MALFORMED_PAYLOAD,
      errors: ["Check response could not be read."],
    };
  }

  if (text.length === 0) {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_MALFORMED_PAYLOAD,
      errors: ["Check response was empty."],
    };
  }

  if (text.length > CHECK_MAX_PAYLOAD_BYTES) {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_PAYLOAD_TOO_LARGE,
      errors: ["Check response exceeded the maximum accepted size."],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_MALFORMED_PAYLOAD,
      errors: ["Check response was not valid JSON."],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_MALFORMED_PAYLOAD,
      errors: ["Check response was not a JSON object."],
    };
  }

  const payload = parsed as HorizonCheckResult & { schema_version?: unknown };

  if (!isSupportedSchemaVersion(payload.schema_version)) {
    return {
      kind: "schema_error",
      reason: CHECK_REASON_UNSUPPORTED_SCHEMA_VERSION,
      errors: [
        `Unsupported check response schema version: ${String(
          payload.schema_version
        )}. Supported majors: ${SUPPORTED_CHECK_SCHEMA_MAJORS.join(", ")}.`,
      ],
    };
  }

  if (isTransientHorizonError(payload.errors)) {
    return { kind: "circuit_open", errors: payload.errors };
  }

  return { kind: "ok", result: payload };
}

/**
 * Perform a single attempt against `/api/check`. Never throws — all failure
 * modes are represented as outcomes. A caller abort wins over the internal
 * timeout so cancellation is never mislabelled as a slow Horizon request.
 */
async function attemptCheck(
  address: string,
  options: { assetCode?: string; assetIssuer?: string; signal?: AbortSignal },
  idempotencyKey: string
): Promise<CheckOutcome> {
  if (options.signal?.aborted) return { kind: "aborted" };

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        address,
        asset_code: options.assetCode,
        asset_issuer: options.assetIssuer,
      }),
      signal: controller.signal,
    });

    if (options.signal?.aborted) return { kind: "aborted" };

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: string[];
      };
      return {
        kind: "rate_limited",
        retryAfterSeconds: parseRetryAfter(response),
        errors: body.errors ?? ["Rate limit exceeded. Please try again later."],
      };
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: string[];
      };
      return {
        kind: "error",
        status: response.status,
        errors: body.errors ?? ["Failed to check address"],
      };
    }

    return await readCheckPayload(response);
  } catch (error) {
    if (options.signal?.aborted) return { kind: "aborted" };
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    // A same-shaped abort can also surface as a plain Error in some
    // environments (e.g. jsdom/node-fetch polyfills) rather than a
    // DOMException — treat any "aborted"-named error the same way.
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

/**
 * Run a check against `/api/check`, retrying transient failures with bounded
 * exponential backoff. Returns a normalized `CheckOutcome`; never throws.
 */
export async function checkAddress(
  address: string,
  options: { assetCode?: string; assetIssuer?: string; signal?: AbortSignal } = {}
): Promise<CheckOutcome> {
  const idempotencyKey = createIdempotencyKey();
  let lastOutcome: CheckOutcome = { kind: "network_error" };

  for (let attempt = 0; attempt < CHECK_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = CHECK_RETRY_BASE_MS * 2 ** (attempt - 1);
      const slept = await sleep(backoff, options.signal);
      if (slept === "aborted") return { kind: "aborted" };
    }

    const outcome = await attemptCheck(address, options, idempotencyKey);
    lastOutcome = outcome;

    if (outcome.kind === "ok" || outcome.kind === "aborted") {
      return outcome;
    }

    if (!isRetryable(outcome)) {
      return outcome;
    }
  }

  return lastOutcome;
}
