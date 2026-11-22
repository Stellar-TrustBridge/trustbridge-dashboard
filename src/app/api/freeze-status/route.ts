import { NextRequest, NextResponse } from "next/server";

import { isFreezeWindowActive } from "@/lib/freeze-window";
import {
  checkRateLimit,
  extractClientIp,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/freeze-status
 *
 * Returns the current Wave freeze-window state. Publicly readable so the
 * client-side maintainer dashboard can poll it without a session cookie
 * (the response contains no PII — only operational flags and timestamps).
 *
 * Rate limiting (issue #519):
 *   Up to 60 requests / minute per IP — generous for a polling UI, hard limit
 *   against polling storms during Wave events.  Exceeded IPs receive 429 with
 *   standard RateLimit-* / Retry-After headers.  Cache-Control is preserved on
 *   200 responses so CDN / browser caching still applies.
 *
 *   Unknown client IP (no x-forwarded-for / x-real-ip) uses the safe "unknown"
 *   fallback from extractClientIp() so the route never crashes; in practice a
 *   CDN should resolve true unknowns before they reach the origin.
 *
 * Timezone display (issue #656):
 *   Instants are always emitted as UTC ISO-8601 (`start` / `end`).  When the
 *   org has a configured timezone, the payload additionally carries
 *   `timezone` (IANA name) and `display` (human-readable window rendered in
 *   that zone, DST-aware).  When no timezone is configured these fields are
 *   `null` and consumers fall back to UTC — preserving prior behavior.
 *
 * Overlapping window merge policy (issue #705):
 *   Overlapping or adjacent freeze windows are merged into a single canonical
 *   union by `isFreezeWindowActive()`.  The reported `start` / `end` therefore
 *   describe the merged envelope, and `reason` carries the documented reason
 *   code from the freeze-window module (e.g. `FREEZE_WINDOW_ACTIVE`,
 *   `FREEZE_WINDOW_MERGED`, `FREEZE_WINDOW_INVALID`).  Malformed or oversized
 *   window input never throws here — the module returns a stable inactive
 *   state with a documented reason code, which this route surfaces verbatim.
 *
 * Shape (200):
 * ```json
 * {
 *   "active": true,
 *   "reason": "FREEZE_WINDOW_MERGED",
 *   "start":  "2026-09-24T18:00:00.000Z",
 *   "end":    "2026-09-25T06:00:00.000Z",
 *   "timezone": "America/New_York",
 *   "display": "Sep 24, 2026, 2:00 PM – Sep 25, 2026, 2:00 AM EDT"
 * }
 * ```
 *
 * Shape (429):
 * ```json
 * { "error": "Too many requests", "code": "RATE_LIMIT_EXCEEDED" }
 * ```
 */

/** Max requests per window for this public endpoint. */
const FREEZE_STATUS_MAX_REQUESTS = 60;
/** Window length in milliseconds (1 minute). */
const FREEZE_STATUS_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip = extractClientIp(request);
  // Prefix the key with the route name to avoid collisions with other
  // rate-limited endpoints (e.g. /api/check uses a different limit).
  const identifier = `freeze-status:${ip}`;

  const rateLimitResult = checkRateLimit(identifier, {
    maxRequests: FREEZE_STATUS_MAX_REQUESTS,
    windowMs: FREEZE_STATUS_WINDOW_MS,
  });

  const rateLimitHeaders = buildRateLimitHeaders(
    rateLimitResult,
    FREEZE_STATUS_MAX_REQUESTS,
  );

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Too many requests", code: "RATE_LIMIT_EXCEEDED" },
      {
        status: 429,
        headers: rateLimitHeaders,
        // Intentionally no Cache-Control on 429 — CDNs must not cache error responses.
      },
    );
  }

  // ── Freeze status ─────────────────────────────────────────────────────────
  // isFreezeWindowActive() applies the overlapping-window merge policy
  // (issue #705) and never throws on malformed input; it returns a stable
  // inactive state with a documented reason code instead.
  const status = isFreezeWindowActive();

  return NextResponse.json(
    {
      active: status.active,
      reason: status.reason ?? null,
      start: status.start?.toISOString() ?? null,
      end: status.end?.toISOString() ?? null,
      // Org-timezone display (issue #656).  Optional fields — older
      // freeze-window implementations that don't expose them yield null so
      // the payload shape stays backward compatible.
      timezone: status.timezone ?? null,
      display: status.display ?? null,
    },
    {
      status: 200,
      headers: {
        // Short TTL — freeze state can flip at any point; 15 s lets the UI
        // react quickly while avoiding a thundering herd on every keystroke.
        "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
        // Include rate-limit headers on 200 so proactive clients can back off
        // before hitting the 429 boundary.
        ...rateLimitHeaders,
      },
    },
  );
}
