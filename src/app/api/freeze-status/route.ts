import { NextResponse } from "next/server";

import { isFreezeWindowActive } from "@/lib/freeze-window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/freeze-status
 *
 * Returns the current Wave freeze-window state. Publicly readable so the
 * client-side maintainer dashboard can poll it without a session cookie
 * (the response contains no PII — only operational flags and timestamps).
 *
 * Shape:
 * ```json
 * {
 *   "active": true,
 *   "reason": "Wave roster payout freeze window in effect",
 *   "start":  "2026-09-24T18:00:00.000Z",
 *   "end":    "2026-09-25T06:00:00.000Z"
 * }
 * ```
 */
export async function GET() {
  const status = isFreezeWindowActive();

  return NextResponse.json(
    {
      active: status.active,
      reason: status.reason ?? null,
      start: status.start?.toISOString() ?? null,
      end: status.end?.toISOString() ?? null,
    },
    {
      status: 200,
      headers: {
        // Short TTL — freeze state can flip at any point; 15 s lets the UI
        // react quickly while avoiding a thundering herd on every keystroke.
        "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
      },
    }
  );
}
