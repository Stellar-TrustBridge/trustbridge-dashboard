/**
 * Shared timeout budget for the Wave registration flow.
 *
 * Wave registration performs two sequential network operations:
 *   1. Action lookup (`/api/actions/lookup`)
 *   2. Contributor check (`/api/check`, via `src/lib/check-api-client.ts`)
 *
 * Historically each step carried its own independent timeout, so the worst
 * case latency was the *sum* of both budgets — which made registration feel
 * hung. This module defines a single wall-clock budget that both steps draw
 * from, so the combined flow can never exceed the UX SLA.
 *
 * The budget is expressed as a deadline (absolute epoch ms) rather than a
 * per-step duration. Consumers call `remainingMs()` to derive their own
 * timeout from whatever is left, and `isExhausted()` to fail fast once the
 * budget is spent. This keeps the two clients decoupled while guaranteeing
 * the stacked timeouts stay bounded.
 */

/** Total wall-clock budget for action lookup + check, in milliseconds. */
export const ACTION_LOOKUP_BUDGET_MS = 15_000;

/**
 * Minimum slice of the budget a step needs to be worth attempting. If less
 * than this remains, the step fails fast with `budget_exhausted` instead of
 * firing a request that is guaranteed to be aborted.
 */
export const ACTION_LOOKUP_MIN_SLICE_MS = 500;

export type TimeoutBudget = {
  /** Absolute epoch-ms deadline shared by every step in the flow. */
  readonly deadline: number;
  /** Milliseconds left before the deadline (never negative). */
  remainingMs(): number;
  /** True when fewer than `ACTION_LOOKUP_MIN_SLICE_MS` remain. */
  isExhausted(): boolean;
  /**
   * Derive a per-step timeout capped by the remaining budget. Returns `null`
   * when the budget is exhausted so callers can fail fast.
   */
  sliceMs(): number | null;
};

/**
 * Create a timeout budget starting now. `totalMs` defaults to
 * `ACTION_LOOKUP_BUDGET_MS`; callers may pass a smaller value in tests.
 */
export function createTimeoutBudget(
  totalMs: number = ACTION_LOOKUP_BUDGET_MS,
  now: number = Date.now()
): TimeoutBudget {
  const deadline = now + Math.max(0, totalMs);
  return {
    deadline,
    remainingMs() {
      return Math.max(0, deadline - Date.now());
    },
    isExhausted() {
      return this.remainingMs() < ACTION_LOOKUP_MIN_SLICE_MS;
    },
    sliceMs() {
      const remaining = this.remainingMs();
      return remaining < ACTION_LOOKUP_MIN_SLICE_MS ? null : remaining;
    },
  };
}

export type ActionLookupOutcome =
  | { kind: "ok"; actions: unknown[] }
  | { kind: "budget_exhausted" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network_error" }
  | { kind: "error"; status: number; errors: string[] };

/**
 * Perform an action lookup bounded by the shared budget. Never throws — all
 * failure modes are represented as outcomes. The per-request timeout is
 * derived from the remaining budget so a slow lookup cannot starve the
 * subsequent check call.
 */
export async function lookupActions(
  query: string,
  options: { budget: TimeoutBudget; signal?: AbortSignal }
): Promise<ActionLookupOutcome> {
  if (options.signal?.aborted) return { kind: "aborted" };

  const slice = options.budget.sliceMs();
  if (slice === null) return { kind: "budget_exhausted" };

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), slice);

  try {
    const response = await fetch("/api/actions/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    if (options.signal?.aborted) return { kind: "aborted" };

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        errors?: string[];
      };
      return {
        kind: "error",
        status: response.status,
        errors: body.errors ?? ["Failed to look up actions"],
      };
    }

    const body = (await response.json()) as { actions?: unknown[] };
    return { kind: "ok", actions: body.actions ?? [] };
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
