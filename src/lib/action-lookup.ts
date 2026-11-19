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
