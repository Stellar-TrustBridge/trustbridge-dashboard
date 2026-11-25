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
 * Inverted-range validation (issue #776):
 *   A freeze window whose `end` is not strictly after its `start` is invalid
 *   and would confuse Wave open/closed state.  When the configured window is
 *   inverted (or otherwise malformed) the route responds 422 with a stable
 *   `code` (`FREEZE_WINDOW_INVALID_RANGE`) and a clear `error` message instead
 *   of emitting a misleading `active` flag.  Auth/CSRF/org-scope and
 *   pause/freeze/dry-run semantics are unchanged — this endpoint is public and
 *   read-only.
 *
 * Shape (200):
 * ```json
 * {
 *   "active": true,
 *   "reason": "Wave roster payout freeze window in effect",
 *   "start":  "2026-09-24T18:00:00.000Z",
 *   "end":    "2026-09-25T06:00:00.000Z",
 *   "timezone": "America/New_York",
 *   "display": "Sep 24, 2026, 2:00 PM – Sep 25, 2026, 2:00 AM EDT"
 * }
 * ```
 *
 * Shape (422):
 * ```json
 * {
 *   "error": "Freeze window end must be after start",
 *   "code": "FREEZE_WINDOW_INVALID_RANGE"
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

/** Stable reason code emitted when the configured freeze window is inverted. */
const FREEZE_WINDOW_INVALID_RANGE = "FREEZE_WINDOW_INVALID_RANGE";

/**
 * Detect an inverted or malformed freeze window.  Returns a 422 payload when
 * `end` is not strictly after `start`, or when either bound is an invalid
 * date.  Returns `null` when the window is valid (or absent).
 */
function validateFreezeWindow(status: {
  start?: Date | null;
  end?: Date | null;
}): { error: string; code: string } | null {
  const { start, end } = status;
  if (!start || !end) return null;

  const startMs = start.getTime();
  const endMs = end.getTime();

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return {
      error: "Freeze window start and end must be valid timestamps",
      code: FREEZE_WINDOW_INVALID_RANGE,
    };
  }

  if (endMs <= startMs) {
    return {
      error: "Freeze window end must be after start",
      code: FREEZE_WINDOW_INVALID_RANGE,
    };
  }

  return null;
}

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
  const status = isFreezeWindowActive();

  // ── Inverted-range validation (issue #776) ────────────────────────────────
  const validationError = validateFreezeWindow(status);
  if (validationError) {
    return NextResponse.json(validationError, {
      status: 422,
      headers: {
        // Never cache an invalid-configuration response — operators must see
        // the failure immediately after fixing the window.
        "Cache-Control": "no-store",
        ...rateLimitHeaders,
      },
    });
  }

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
