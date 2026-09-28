import { NextResponse } from "next/server";

import { buildStatsCacheHeaders, parseStatsCacheTtl } from "@/lib/cache";
import { getDashboardStats } from "@/lib/registrations";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/stats
 *
 * Returns aggregate contributor readiness statistics for the public landing
 * page and the maintainer dashboard.
 *
 * ## Caching strategy
 *
 * The response is safe to cache publicly:
 * - It contains only aggregate counts — no contributor PII.
 * - Staleness is bounded by `STATS_CACHE_TTL_MS` (default 60 s).
 *
 * Two caching layers work together:
 * 1. **In-process `statsCache`** — `getDashboardStats()` caches the DB query
 *    result for `STATS_CACHE_TTL_MS` ms, so repeated requests within a single
 *    server instance never hit the database.
 * 2. **HTTP `Cache-Control` headers** — the response carries
 *    `public, max-age=<ttl>, stale-while-revalidate=<swr>` so CDN edges
 *    (Vercel Edge Network, Cloudflare, etc.) and browsers can serve cached
 *    responses without hitting the origin at all.
 *
 * The cache is automatically invalidated when contributor readiness changes
 * (see `recheckRegistration` in `src/lib/registrations.ts`).
 *
 * ### Edge cases
 * - **Horizon / RPC outage** — `getDashboardStats()` reads from the database
 *   only; it does not call Horizon directly. If the DB is unreachable the
 *   error propagates naturally (500) — the stale CDN copy continues to serve
 *   during a transient outage.
 * - **Invalid env config** — `parseStatsCacheTtl()` falls back to 60 s for
 *   any non-positive or non-numeric value.
 * - **100+ contributor scale** — the query uses a lean `select` (no joins)
 *   so it remains efficient even at large contributor counts.
 */
export async function GET() {
  const stats = await getDashboardStats();
  const ttlMs = parseStatsCacheTtl();

  return withPublicCors(NextResponse.json(stats, {
    headers: buildStatsCacheHeaders(ttlMs),
  }));
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
}
