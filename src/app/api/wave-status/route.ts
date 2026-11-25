import { NextRequest, NextResponse } from "next/server";

import {
  checkRateLimit,
  extractClientIp,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";
import { getWavePublicStatus } from "@/lib/wave-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/wave-status
 *
 * Public, unauthenticated endpoint that returns the current Wave operational
 * status as a single typed banner payload.  Merges two signals:
 *
 *  1. Freeze window — whether the roster is frozen for Wave payout.
 *  2. Contract-sync queue lag — whether the Soroban→Postgres sync is behind.
 *
 * The combined `overallStatus` is what the client banner renders; individual
 * signal fields (`freeze`, `queueLag`) are available for detailed tooltips.
 *
 * Rate limit: 60 req / min per IP (matches `/api/freeze-status`).
 * Cache-Control: public, 15 s — short enough to react to a freeze activation
 * within one polling interval, CDN-safe because the response contains no PII.
 *
 * Shape (200):
 * ```json
 * {
 *   "overallStatus": "frozen",
 *   "freeze": { "active": true, "reason": "...", "start": "...", "end": "..." },
 *   "queueLag": { "status": "ok", "reason": "ok", "sinceLastSuccessMs": 120000, "thresholdMs": 900000 },
 *   "message": "The Wave roster is currently frozen...",
 *   "computedAt": "2026-09-25T00:30:00.000Z"
 * }
 * ```
 *
 * Shape (429):
 * ```json
 * { "error": "Too many requests", "code": "RATE_LIMIT_EXCEEDED" }
 * ```
 */

const WAVE_STATUS_MAX_REQUESTS = 60;
const WAVE_STATUS_WINDOW_MS = 60_000;

export async function GET(request: NextRequest) {
  const ip = extractClientIp(request);
  const identifier = `wave-status:${ip}`;

  const rateLimitResult = checkRateLimit(identifier, {
    maxRequests: WAVE_STATUS_MAX_REQUESTS,
    windowMs: WAVE_STATUS_WINDOW_MS,
  });

  const rateLimitHeaders = buildRateLimitHeaders(
    rateLimitResult,
    WAVE_STATUS_MAX_REQUESTS
  );

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Too many requests", code: "RATE_LIMIT_EXCEEDED" },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  const status = await getWavePublicStatus();

  return NextResponse.json(status, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
      ...rateLimitHeaders,
    },
  });
}
