import { getServerSession } from "next-auth";
import { type NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { getMaintainerOrgId } from "@/lib/api-auth";
import { getSorobanEventTimeline } from "@/lib/soroban";
import {
  parseSorobanEventCursor,
  buildInvalidCursorError,
  SOROBAN_CURSOR_MAX_LENGTH,
} from "@/lib/soroban-cursor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);

  if (!session?.user?.isMaintainer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Cursor validation ─────────────────────────────────────────────────────
  // `cursor` is optional — omitted or empty means "latest window" (first
  // page).  When present it must be a non-empty string that passes the cursor
  // shape check; anything else is a client error, not a server error.
  const { searchParams } = new URL(request.url);
  const rawCursor = searchParams.get("cursor");

  let cursor: string | undefined;
  if (rawCursor !== null && rawCursor.trim() !== "") {
    const validation = parseSorobanEventCursor(rawCursor);
    if (!validation.ok) {
      return NextResponse.json(
        buildInvalidCursorError(rawCursor),
        { status: 400 }
      );
    }
    cursor = validation.cursor;
  }

  // ── Org scope ─────────────────────────────────────────────────────────────
  const orgId = getMaintainerOrgId(session);

  const timeline = await getSorobanEventTimeline({ cursor, orgId });
  return NextResponse.json(timeline);
}
