import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  API_KEY_RATE_LIMIT,
  authenticateApiKey,
  buildRateLimitHeaders,
  hasScope,
  insufficientScopeResponse,
} from "@/lib/api-key-auth";
import { recordAuditLog } from "@/lib/audit";
import {
  getContributors,
} from "@/lib/registrations";
import {
  buildContributorsCsv,
  getContributorsCsvFilename,
  streamContributorsCsv,
  CSV_EXPORT_STREAM_THRESHOLD,
} from "@/lib/csv-export";
import {
  checkRateLimit,
  extractClientIp,
  ROUTE_BUDGETS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // ── Per-IP rate limit for session-auth path ───────────────────────────
  // The API-key path has its own 60 req/min budget enforced inside
  // `authenticateApiKey`; this guard targets browser sessions so a
  // maintainer clicking "Export" in a loop doesn't hammer the DB.
  const clientIp = extractClientIp(request);
  const ipRateLimit = checkRateLimit(`export:${clientIp}`, ROUTE_BUDGETS.export);
  if (!ipRateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many export requests. Please wait before retrying." },
      {
        status: 429,
        headers: buildRateLimitHeaders(ipRateLimit, ROUTE_BUDGETS.export.maxRequests),
      }
    );
  }

  // ── Auth: session (browser) OR API key (cron/automation) ──────────────
  let actorId: string | null = null;
  let actorLogin: string | null = null;

  const session = await requireMaintainerSession();
  if (session) {
    actorId = session.user.id;
    actorLogin = session.user.githubUsername ?? null;
  } else {
    const apiKeyAuth = await authenticateApiKey(request);

    if (!apiKeyAuth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if ("rateLimited" in apiKeyAuth) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: buildRateLimitHeaders(
            apiKeyAuth.result,
            API_KEY_RATE_LIMIT.maxRequests
          ),
        }
      );
    }

    if (!hasScope(apiKeyAuth.scopes, "export:read")) {
      return insufficientScopeResponse("export:read");
    }

    actorId = apiKeyAuth.createdById;
    actorLogin = `api-key:${apiKeyAuth.name}`;
  }

  try {
    const { contributors, total } = await getContributors();

    if (contributors.length === 0) {
      return NextResponse.json(
        { error: "No contributors to export", code: "EXPORT_EMPTY" },
        { status: 400 }
      );
    }

    const filename = getContributorsCsvFilename();

    await recordAuditLog({
      action: "export.csv",
      actorId,
      actorLogin,
      metadata: {
        contributorCount: total,
        filename,
        mode:
          contributors.length >= CSV_EXPORT_STREAM_THRESHOLD
            ? "stream"
            : "buffered",
      },
    });

    const headers = {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    };

    // Large exports stream incrementally to avoid buffering the whole dataset
    // in memory. Small exports keep the existing buffered response shape.
    if (contributors.length >= CSV_EXPORT_STREAM_THRESHOLD) {
      const stream = streamContributorsCsv(contributors, {
        signal: request.signal,
      });

      return new NextResponse(stream, { status: 200, headers });
    }

    const csv = buildContributorsCsv(contributors);

    return new NextResponse(csv, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAuditLog({
      action: "export.csv.failed",
      actorId,
      actorLogin,
      metadata: { error: message },
    });

    return NextResponse.json(
      { error: "Failed to export CSV", details: message },
      { status: 500 }
    );
  }
}
