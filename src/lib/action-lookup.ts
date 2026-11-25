import type { HorizonCheckResult } from "@/types";

/** Pure helpers — safe for client and server; no stellar-sdk. */

/**
 * In-process cache lifetime for `GET /api/actions/lookup` (30 seconds).
 *
 * Short enough to keep wizard validation fresh, long enough to absorb bursts
 * against Horizon rate limits. The same value drives the `Cache-Control` and
 * `stale-while-revalidate` headers on the response.
 */
export const ACTION_LOOKUP_CACHE_TTL_MS = 30_000;

/**
 * Negative cache lifetime for lookups that resolved to a missing Action repo
 * or ref (HTTP 404). Deliberately shorter than the positive TTL so a repo that
 * is created or a ref that is pushed shortly after a miss is picked up quickly,
 * while still absorbing repeated 404 bursts on Wave registration pages.
 */
export const ACTION_LOOKUP_NEGATIVE_CACHE_TTL_MS = 5_000;

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


/**
 * Component escaping for cache keys.
 *
 * `encodeURIComponent` escapes `:`, `|`, `/` and whitespace, so no component
 * can spoof a separator and collide with a different scope. The extra pass
 * covers the handful of unescaped punctuation characters it leaves intact.
 */
function normalizeKeyPart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`buildActionLookupCacheKey: ${field} is required`);
  }
  return encodeURIComponent(trimmed).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Build the in-process cache key for an action lookup.
 *
 * Scope is ordered `orgId : network : address : assetCode : assetIssuer`.
 * Org and network come first so a cached result can never be served to a
 * different tenant or network, even when the address/asset triple is equal.
 * Every component is escaped (see {@link normalizeKeyPart}), so values that
 * contain separators cannot produce a colliding key.
 */
export function buildActionLookupCacheKey(scope: {
  orgId: string;
  network: string;
  address: string;
  assetCode: string;
  assetIssuer: string;
}): string {
  return [
    "action-lookup",
    // Org identity is case-insensitive everywhere else in the dashboard.
    normalizeKeyPart(scope.orgId.toLowerCase(), "orgId"),
    normalizeKeyPart(scope.network, "network"),
    normalizeKeyPart(scope.address, "address"),
    normalizeKeyPart(scope.assetCode, "assetCode"),
    normalizeKeyPart(scope.assetIssuer, "assetIssuer"),
  ].join(":");
}

/**
 * Build the negative cache key for a lookup that resolved to a missing Action
 * repo/ref (HTTP 404).
 *
 * Uses a distinct `action-lookup-miss` namespace so a negative entry can never
 * be confused with — or overwrite — a positive result for the same scope. The
 * scope components are identical to {@link buildActionLookupCacheKey}.
 */
export function buildActionLookupNegativeCacheKey(scope: {
  orgId: string;
  network: string;
  address: string;
  assetCode: string;
  assetIssuer: string;
}): string {
  return [
    "action-lookup-miss",
    normalizeKeyPart(scope.orgId.toLowerCase(), "orgId"),
    normalizeKeyPart(scope.network, "network"),
    normalizeKeyPart(scope.address, "address"),
    normalizeKeyPart(scope.assetCode, "assetCode"),
    normalizeKeyPart(scope.assetIssuer, "assetIssuer"),
  ].join(":");
}

/**
 * Normalize resolved Horizon/RPC URLs into a stable network identifier.
 *
 * Kept pure so the lookup route can reuse the env resolvers in
 * `src/lib/network-config.ts` while the key composition stays server-agnostic.
 * Protocol, host (including explicit port) and path are significant; query
 * strings, hashes and trailing slashes are not. Custom/self-hosted endpoints
 * therefore get distinct cache scopes instead of sharing a single "custom"
 * bucket.
 */
export function normalizeActionLookupNetwork(
  horizonUrl: string,
  sorobanRpcUrl?: string | null
): string {
  const normalizeEndpoint = (raw: string | null | undefined): string => {
    const value = raw?.trim();
    if (!value) return "unset";
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${url.host.toLowerCase()}${path}`;
    } catch {
      return "invalid-url";
    }
  };

  return `horizon:${normalizeEndpoint(horizonUrl)}|rpc:${normalizeEndpoint(
    sorobanRpcUrl
  )}`;
}

/** Allowed org-id shape: lowercase alphanumeric with separators, 1–64 chars. */
const ORG_ID_REGEX = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function normalizeOrgId(value: string | null | undefined): string | null {
  const org = value?.trim().toLowerCase();
  return org && ORG_ID_REGEX.test(org) ? org : null;
}

/**
 * Resolve the org scope for a public lookup.
 *
 * A validated `org` query parameter wins; otherwise the configured maintainer
 * org is used, falling back to `"default"`. When an allow-list is supplied the
 * requested org must appear in it, so arbitrary client-supplied strings cannot
 * create unbounded cache entries. Missing/malformed values fall back rather
 * than failing the public request.
 */
export function resolveActionLookupOrgScope(
  requestedOrg: string | null | undefined,
  options: {
    configuredOrg?: string | null;
    allowedOrgs?: readonly string[];
  } = {}
): string {
  const requested = normalizeOrgId(requestedOrg);
  const allowed = (options.allowedOrgs ?? [])
    .map((org) => normalizeOrgId(org))
    .filter((org): org is string => org !== null);

  if (requested && (allowed.length === 0 || allowed.includes(requested))) {
    return requested;
  }

  return normalizeOrgId(options.configuredOrg) ?? "default";
}

export type WizardAction =
  | "fund_account"
  | "add_trustline"
  | "await_trustline_authorization"
  | "increase_reserve"
  | "none";

export interface ActionLookupResult extends HorizonCheckResult {
  nextAction: WizardAction;
}

/**
 * Plain-language "what to do next", keyed by reason code.
 *
 * These strings are read by contributors who may never have used Stellar, so
 * each one names the jargon term once, in parentheses, and then explains the
 * step in ordinary words. Keep them aligned with `docs/READINESS_MODEL.md` and
 * with `READINESS_CONFIG` in `src/lib/readiness.ts` — `readiness-copy.test.ts`
 * asserts that every reason code stays reachable and consistently worded.
 */
export const WIZARD_ACTION_COPY: Record<WizardAction, string> = {
  fund_account:
    "Send at least 1 XLM to this address. A Stellar wallet does not exist until someone puts a little XLM in it, and payouts cannot reach a wallet that does not exist yet.",
  add_trustline:
    "Turn on USDC for this wallet (Stellar calls this \"adding a trustline\"). A Stellar wallet has to opt in to each kind of token before it can receive it.",
  await_trustline_authorization:
    "USDC is turned on, but the company that issues USDC has not approved this wallet yet. Wait for that approval — if it takes more than a day, contact the issuer.",
  increase_reserve:
    "Add a little more XLM. Stellar keeps a small amount locked in every wallet as a deposit, and this wallet is below the amount it needs to keep working.",
  none: "Nothing to do — this wallet can receive payouts.",
};


/**
 * In-memory negative cache for Action repo lookups that returned HTTP 404.
 * Keyed by repo slug; values are expiry timestamps (epoch ms).
 */
const actionLookupNegativeCache = new Map<string, number>();

/** Alias kept for tests and callers that use the shorter name. */
export const NEGATIVE_CACHE_TTL_MS = ACTION_LOOKUP_NEGATIVE_CACHE_TTL_MS;

/** Clear the negative cache (tests / admin reset). */
export function resetActionLookupNegativeCache(): void {
  actionLookupNegativeCache.clear();
}

export type ActionRepoLookupResult =
  | { found: true; data?: unknown; cached?: false }
  | { found: false; cached: boolean; error?: string };

/**
 * Look up an Action repo, negatively caching HTTP 404 responses for
 * {@link NEGATIVE_CACHE_TTL_MS} so repeated Wave registration hits do not
 * stampede a missing repo. Non-404 failures are not cached.
 */
export async function lookupActionRepo(
  repo: string,
  options: {
    fetcher: (repo: string) => Promise<{ status: number; data?: unknown }>;
    now?: number;
  }
): Promise<ActionRepoLookupResult> {
  const now = options.now ?? Date.now();
  const cachedUntil = actionLookupNegativeCache.get(repo);
  if (cachedUntil !== undefined) {
    if (cachedUntil > now) {
      return { found: false, cached: true };
    }
    actionLookupNegativeCache.delete(repo);
  }

  const response = await options.fetcher(repo);
  if (response.status === 404) {
    actionLookupNegativeCache.set(repo, now + NEGATIVE_CACHE_TTL_MS);
    return { found: false, cached: false };
  }
  if (response.status < 200 || response.status >= 300) {
    return { found: false, cached: false, error: `HTTP ${response.status}` };
  }
  return { found: true, data: response.data };
}

export function computeNextAction(
  result: Pick<
    HorizonCheckResult,
    "funded" | "trustline" | "trustline_authorized" | "readiness"
  >
): WizardAction {
  if (!result.funded) return "fund_account";
  if (!result.trustline) return "add_trustline";
  if (!result.trustline_authorized) return "await_trustline_authorization";
  if (result.readiness === "low_reserve") return "increase_reserve";
  return "none";
}

export function buildActionLookupResult(
  result: HorizonCheckResult
): ActionLookupResult {
  return {
    ...result,
    nextAction: computeNextAction(result),
  };
}
