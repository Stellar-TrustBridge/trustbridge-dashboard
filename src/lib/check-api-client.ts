import type { HorizonCheckResult } from "@/types";
import {
  ACTION_LOOKUP_BUDGET_MS,
  createTimeoutBudget,
  type TimeoutBudget,
} from "@/lib/action-lookup";

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
 *    for a while), so this wrapper applies its own timeout via an
 *    `AbortController` and also relays a caller-provided AbortSignal.
 *
 * This helper normalizes all of that into a single discriminated union so
 * UI code can `switch` on `outcome.kind` instead of re-deriving these rules.
 *
 * Retries: transient failures (timeout, network error, circuit-open, and
 * 429/5xx responses) are retried a bounded number of times. Every attempt
 * carries the same `Idempotency-Key` for correlation, but `/api/check` is a
 * read-only Horizon check and does not dedupe requests on that header.
 *
 * Timeout budget: the per-attempt timeout is derived from a shared
 * `TimeoutBudget` (see `src/lib/action-lookup.ts`) so the action lookup and
 * the check call together cannot exceed the UX SLA. When no budget is
 * supplied, a fresh one is created from `ACTION_LOOKUP_BUDGET_MS`.
 *
 * Circuit-breaker isolation: the dashboard talks to two independent
 * dependencies — Horizon (contributor checks, via `/api/check`) and Soroban
 * (contract sync, via `src/lib/contract-sync.ts`). Each dependency owns its
 * own breaker key (`horizon` vs `soroban`), so a Soroban outage must never
 * open the Horizon circuit and vice versa. This module only ever observes
 * the Horizon breaker; it must not treat a Soroban-side failure as a
 * Horizon circuit-open signal. See `docs/ARCHITECTURE.md` for the topology.
 */

/**
 * Default per-attempt timeout for `/api/check` when no shared budget is
 * supplied. Kept as a named export for backwards compatibility; the actual
 * timeout is capped by the remaining shared budget at call time.
 */
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

export type CheckOutcome =
  | { kind: "ok"; result: HorizonCheckResult }
  | { kind: "rate_limited"; retryAfterSeconds: number | null; errors: string[] }
  | { kind: "circuit_open"; errors: string[] }
  | { kind: "timeout" }
  | { kind: "budget_exhausted" }
  | { kind: "aborted" }
  | { kind: "network_error" }
  | { kind: "error"; status: number; errors: string[] };

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
 * wait longer than our bounded backoff budget.
 */
function isRetryable(outcome: CheckOutcome): boolean {
  switch (outcome.kind) {
    case "aborted":
    case "budget_exhausted":
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
 * Perform a single attempt against `/api/check`. Never throws — all failure
 * modes are represented as outcomes. A caller abort wins over the internal
 * timeout so cancellation is never mislabelled as a slow Horizon request.
 * The per-attempt timeout is capped by the remaining shared budget.
 */
async function attemptCheck(
  address: string,
  options: {
    assetCode?: string;
    assetIssuer?: string;
    signal?: AbortSignal;
    budget: TimeoutBudget;
  },
  idempotencyKey: string
): Promise<CheckOutcome> {
  if (options.signal?.aborted) return { kind: "aborted" };

  const slice = options.budget.sliceMs();
  if (slice === null) return { kind: "budget_exhausted" };
  const timeoutMs = Math.min(CHECK_TIMEOUT_MS, slice);

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

    const result = (await response.json()) as HorizonCheckResult;

    if (isTransientHorizonError(result.errors)) {
      return { kind: "circuit_open", errors: result.errors };
    }

    return { kind: "ok", result };
  } catch (error) {
    if (options.signal?.aborted) return { kind: "aborted" };
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "timeout" };
    }
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
 * Run a check against `/api/check`, retrying transient failures within the
 * shared timeout budget. When no budget is supplied a fresh one is created
 * from `ACTION_LOOKUP_BUDGET_MS`, so a standalone check still respects the
 * same UX SLA as the combined Wave registration flow.
 */
export async function checkAddress(
  address: string,
  options: {
    assetCode?: string;
    assetIssuer?: string;
    signal?: AbortSignal;
    budget?: TimeoutBudget;
  } = {}
): Promise<CheckOutcome> {
  const budget = options.budget ?? createTimeoutBudget(ACTION_LOOKUP_BUDGET_MS);
  const idempotencyKey = createIdempotencyKey();

  let lastOutcome: CheckOutcome = { kind: "network_error" };

  for (let attempt = 0; attempt < CHECK_MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { kind: "aborted" };
    if (budget.isExhausted()) return { kind: "budget_exhausted" };

    const outcome = await attemptCheck(
      address,
      { ...options, budget },
      idempotencyKey
    );
    lastOutcome = outcome;

    if (outcome.kind === "ok" || outcome.kind === "aborted") return outcome;
    if (outcome.kind === "budget_exhausted") return outcome;
    if (!isRetryable(outcome)) return outcome;
    if (attempt === CHECK_MAX_ATTEMPTS - 1) return outcome;

    const backoff = CHECK_RETRY_BASE_MS * 2 ** attempt;
    if (budget.remainingMs() <= backoff) return outcome;

    const slept = await sleep(backoff, options.signal);
    if (slept === "aborted") return { kind: "aborted" };
  }

  return lastOutcome;
}
