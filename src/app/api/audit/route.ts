import { NextRequest, NextResponse } from "next/server";

import { requireOperator } from "@/lib/api-auth";
import { getRecentAuditLog } from "@/lib/audit";
import { hashAuditBundle, summarizeAuditLog } from "@/lib/audit-format";
import { captureException } from "@/lib/sentry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upper bound on a single page so large-org exports stay bounded. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/**
 * Parse the `limit` query param into a bounded page size.
 * Returns a stable error code for malformed or oversized input so
 * operators get an actionable message instead of a silent default.
 */
function parseLimit(raw: string | null):
  | { ok: true; limit: number }
  | { ok: false; code: string; message: string } {
  if (raw === null || raw === "") {
    return { ok: true, limit: DEFAULT_LIMIT };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      code: "invalid_limit",
      message: "limit must be a positive integer",
    };
  }

  if (parsed > MAX_LIMIT) {
    return {
      ok: false,
      code: "limit_too_large",
      message: `limit must be <= ${MAX_LIMIT}; page through results with offset`,
    };
  }

  return { ok: true, limit: parsed };
}

/** Operator-only view of recent maintainer actions. */
export async function GET(request: NextRequest) {
  if (!(await requireOperator("audit.read"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limitResult = parseLimit(request.nextUrl.searchParams.get("limit"));
  if (!limitResult.ok) {
    return NextResponse.json(
      { error: limitResult.message, code: limitResult.code },
      { status: 400 },
    );
  }

  const limit = limitResult.limit;

  try {
    const entries = await getRecentAuditLog(limit);
    return NextResponse.json({
      entries,
      summary: summarizeAuditLog(entries),
      hash: hashAuditBundle(entries),
      pagination: {
        limit,
        maxLimit: MAX_LIMIT,
        returned: entries.length,
        hasMore: entries.length === limit,
      },
    });
  } catch (error) {
    captureException(error);
    return NextResponse.json(
      { error: "Failed to load audit log" },
      { status: 500 },
    );
  }
}
