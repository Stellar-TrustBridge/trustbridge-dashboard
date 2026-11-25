/**
 * @module rate-limit
 *
 * Per-IP sliding-window rate limiter for `POST /api/check`.
 *
 * ## ⚠️ Process-local store — multi-instance caveat
 *
 * The `store` below is a plain in-process `Map`.  It is **not** shared across
 * Node.js processes, server replicas, or serverless function invocations.
 *
 * Consequence: on a horizontally scaled deployment (multiple Vercel containers,
 * a Kubernetes replica set, a PM2 cluster, or a burst of serverless cold-starts)
 * each instance enforces its own independent counter.  A client that lands on a
 * different instance for each request can make up to
 * `RATE_LIMIT_MAX_REQUESTS × <instance_count>` requests before any one process
 * throttles it.
 *
 * This is acceptable for a single-process deployment. For multi-instance
 * environments, choose one of the recommended mitigations documented in
 * `docs/ENVIRONMENT.md` (§ Rate limiting) and `docs/LOGGING_AND_PAGINATION.md`
 * (§ Rate Limiting):
 *
 *   - Edge / CDN rate limiting (Vercel WAF, Cloudflare, AWS WAF) — recommended
 *   - Sticky sessions (IP affinity at the load balancer)
 *   - Redis-backed store (e.g. `@upstash/ratelimit`) for exact cluster-wide counts
 *
 * ## Per-route budgets
 *
 * Different endpoints have different traffic profiles and risk surfaces:
 *
 * | Route | Budget | Rationale |
 * |---|---|---|
 * | `POST /api/register` | 10 req/min | Writes to DB + Horizon; prevent address-scanning abuse |
 * | `GET /api/contributors/export/csv` | 20 req/min | Expensive full-table read; API-key rate limit from api-key-auth also applies |
 * | `GET /api/contributors/export/json` | 20 req/min | Same as CSV export |
 * | `GET /api/stats` | 120 req/min | Public read; in-process cache absorbs DB load |
 * | `POST /api/check` | 10 req/min (global default) | Horizon call per request |
 *
 * Routes pass one of the exported `ROUTE_BUDGETS.*` constants to `checkRateLimit`
 * as the `options` argument.  The process-wide env-var defaults (`RATE_LIMIT_WINDOW_MS`
 * / `RATE_LIMIT_MAX_REQUESTS`) continue to serve as the fallback for routes that
 * do not specify an explicit budget.
 */
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Per-route budget constants
// ---------------------------------------------------------------------------

/**
 * Documented per-route rate-limit budgets.
 *
 * Import the relevant constant in each route handler instead of hard-coding
 * numbers.  This keeps the budget table in the module-level JSDoc and in
 * `docs/DEPLOYMENT.md` consistent with what the code actually enforces.
 *
 * All windows are 60 seconds (sliding).  Multi-instance caveat applies —
 * see module JSDoc.
 */
export const ROUTE_BUDGETS = {
  /**
   * `POST /api/register` — 10 req/min.
   *
   * Registration triggers a Horizon `loadAccount` call and a Postgres upsert;
   * address-scanning or automated bulk registration would put heavy load on
   * both.  10 is generous for a human user submitting forms but tight enough
   * to absorb a scripted burst.
   *
   * Override at deploy time via `REGISTER_RATE_LIMIT_MAX_REQUESTS` and
   * `REGISTER_RATE_LIMIT_WINDOW_MS` env vars.
   */
  register: parseRouteBudget(
    "REGISTER_RATE_LIMIT_WINDOW_MS",
    "REGISTER_RATE_LIMIT_MAX_REQUESTS",
    { windowMs: 60_000, maxRequests: 10 },
  ),

  /**
   * `GET /api/contributors/export/csv` — 20 req/min.
   *
   * Full-table read from Postgres; each call loads all contributor rows.
   * 20/min is enough for automated tooling running on a schedule while still
   * guarding against an accidentally looping script.
   *
   * Override via `EXPORT_RATE_LIMIT_MAX_REQUESTS` and
   * `EXPORT_RATE_LIMIT_WINDOW_MS`.
   */
  export: parseRouteBudget(
    "EXPORT_RATE_LIMIT_WINDOW_MS",
    "EXPORT_RATE_LIMIT_MAX_REQUESTS",
    { windowMs: 60_000, maxRequests: 20 },
  ),

  /**
   * `GET /api/stats` — 120 req/min.
   *
   * Public, aggregate-only endpoint.  The in-process `statsCache` absorbs
   * most DB load, so the per-IP limit mainly prevents a single IP from
   * flushing the CDN edge cache.
   *
   * Override via `STATS_RATE_LIMIT_MAX_REQUESTS` and
   * `STATS_RATE_LIMIT_WINDOW_MS`.
   */
  stats: parseRouteBudget(
    "STATS_RATE_LIMIT_WINDOW_MS",
    "STATS_RATE_LIMIT_MAX_REQUESTS",
    { windowMs: 60_000, maxRequests: 120 },
  ),
} satisfies Record<string, RateLimitOptions>;

/**
 * Parse a per-route budget from two env vars, falling back to the provided
 * defaults when either var is absent or invalid.
 *
 * Intentionally not exported as a named function — only `ROUTE_BUDGETS` is
 * the public surface.  The name is used in JSDoc references above so the
 * pattern is easy to follow when adding new routes.
 */
function parseRouteBudget(
  windowVar: string,
  maxVar: string,
  defaults: RateLimitOptions,
): RateLimitOptions {
  const rawWindow = process.env[windowVar];
  const rawMax = process.env[maxVar];

  const windowMs =
    rawWindow &&
    Number.isFinite(Number.parseInt(rawWindow, 10)) &&
    Number.parseInt(rawWindow, 10) > 0
      ? Number.parseInt(rawWindow, 10)
      : defaults.windowMs;

  const maxRequests =
    rawMax &&
    Number.isFinite(Number.parseInt(rawMax, 10)) &&
    Number.parseInt(rawMax, 10) > 0
      ? Number.parseInt(rawMax, 10)
      : defaults.maxRequests;

  return { windowMs, maxRequests };
}

interface RateLimitEntry {
  timestamps: number[];
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitMetrics {
  activeIdentifiers: number;
  totalAllowed: number;
  totalBlocked: number;
  options: RateLimitOptions;
  processLocal: boolean;
}

const store = new Map<string, RateLimitEntry>();
let totalAllowedRequests = 0;
let totalBlockedRequests = 0;

function getDefaultOptions(): RateLimitOptions {
  const windowMs = Number.parseInt(
    process.env.RATE_LIMIT_WINDOW_MS ?? "60000",
    10
  );
  const maxRequests = Number.parseInt(
    process.env.RATE_LIMIT_MAX_REQUESTS ?? "10",
    10
  );
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 10,
  };
}

export function checkRateLimit(
  identifier: string,
  options?: Partial<RateLimitOptions>
): { allowed: boolean; retryAfter: number; remaining: number } {
  const opts = { ...getDefaultOptions(), ...options };
  const now = Date.now();
  const entry = store.get(identifier);

  if (!entry) {
    store.set(identifier, { timestamps: [now] });
    totalAllowedRequests++;
    return { allowed: true, retryAfter: 0, remaining: opts.maxRequests - 1 };
  }

  const validTimestamps = entry.timestamps.filter(
    (t) => now - t < opts.windowMs
  );

  if (validTimestamps.length >= opts.maxRequests) {
    const oldest = validTimestamps[0];
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest + opts.windowMs - now) / 1000)
    );
    store.set(identifier, { timestamps: validTimestamps });
    totalBlockedRequests++;
    return { allowed: false, retryAfter, remaining: 0 };
  }

  validTimestamps.push(now);
  store.set(identifier, { timestamps: validTimestamps });
  totalAllowedRequests++;
  return {
    allowed: true,
    retryAfter: 0,
    remaining: opts.maxRequests - validTimestamps.length,
  };
}

export function getRateLimitMetrics(): RateLimitMetrics {
  const now = Date.now();
  const opts = getDefaultOptions();
  let activeCount = 0;

  for (const entry of Array.from(store.values())) {
    const hasRecent = entry.timestamps.some((t) => now - t < opts.windowMs);
    if (hasRecent) {
      activeCount++;
    }
  }

  return {
    activeIdentifiers: activeCount,
    totalAllowed: totalAllowedRequests,
    totalBlocked: totalBlockedRequests,
    options: { ...opts },
    processLocal: true,
  };
}

export function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "unknown";
}

/**
 * Build standard RateLimit-* response headers (draft-ietf-httpapi-ratelimit-headers-07).
 *
 * - `RateLimit-Limit` — max requests per window
 * - `RateLimit-Remaining` — requests left in current window
 * - `RateLimit-Reset` — seconds until the window resets
 * - `Retry-After` — seconds to wait (only set when `retryAfter > 0`)
 *
 * Multi-instance note: in-memory counters are per-process. When running
 * behind a load balancer with N instances, the effective limit is roughly
 * N × maxRequests. This is documented in ENVIRONMENT.md.
 */
export function buildRateLimitHeaders(
  result: { allowed: boolean; retryAfter: number; remaining: number },
  maxRequests: number
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(maxRequests),
    "RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "RateLimit-Reset": String(Math.max(0, result.retryAfter)),
  };

  if (!result.allowed && result.retryAfter > 0) {
    headers["Retry-After"] = String(result.retryAfter);
  }

  return headers;
}

/**
 * Reset rate limit state for a given identifier or all identifiers.
 * Primarily for testing.
 */
export function resetRateLimit(identifier?: string): void {
  if (identifier) {
    store.delete(identifier);
  } else {
    store.clear();
    totalAllowedRequests = 0;
    totalBlockedRequests = 0;
  }
}

/**
 * Simulate a burst of requests against the limiter for a single identifier.
 *
 * Used by the burst tests (and the Wave k6 scenario) to assert that a burst
 * of `count` requests yields exactly `maxRequests` allowed responses followed
 * by `429`-worthy blocks, with consistent `RateLimit-*` headers on every
 * response.  This is a thin wrapper over `checkRateLimit` — it does not
 * introduce a parallel limiter, it just exercises the existing one.
 *
 * Returns one entry per request in order, each carrying the limiter result
 * and the headers that `POST /api/check` would emit for it.
 */
export function simulateBurst(
  identifier: string,
  count: number,
  options?: Partial<RateLimitOptions>
): Array<{
  allowed: boolean;
  retryAfter: number;
  remaining: number;
  headers: Record<string, string>;
}> {
  const opts = { ...getDefaultOptions(), ...options };
  const results: Array<{
    allowed: boolean;
    retryAfter: number;
    remaining: number;
    headers: Record<string, string>;
  }> = [];

  for (let i = 0; i < count; i++) {
    const result = checkRateLimit(identifier, opts);
    results.push({
      ...result,
      headers: buildRateLimitHeaders(result, opts.maxRequests),
    });
  }

  return results;
}
