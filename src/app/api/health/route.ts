import { NextResponse } from "next/server";

import { getContractSyncHealth } from "@/lib/contract-sync";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { toContributorRow } from "@/lib/registrations";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: { status: HealthStatus; latencyMs: number; error?: string };
    csvStaleness: {
      status: HealthStatus;
      staleCount: number;
      totalCount: number;
      stalePercent: number;
      warning: string;
    };
    contractSync: {
      status: HealthStatus;
      lastRunAt: string | null;
      lastError?: string;
    };
  };
  version: string;
}

/**
 * GET /api/health
 *
 * Lightweight liveness + readiness probe for the TrustBridge Dashboard.
 *
 * Always returns 200 so load-balancer liveness checks never kill the pod on a
 * degraded-but-alive service. Use the `status` field in the body to
 * distinguish:
 *
 * - `"ok"`       — database reachable, CSV data fresh
 * - `"degraded"` — database reachable but CSV data is stale (Wave risk)
 * - `"error"`    — database unreachable (critical)
 *
 * The response is intentionally unauthenticated so monitoring tools can poll
 * it without credentials. **No contributor PII is exposed** — only aggregate
 * counts and percentages are returned.
 *
 * @see docs/SENTRY.md for how Sentry integrates with this endpoint.
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const timestamp = new Date().toISOString();
  const version = process.env.npm_package_version ?? "0.1.0";

  // ------------------------------------------------------------------
  // Database check
  // ------------------------------------------------------------------
  let dbStatus: HealthStatus = "ok";
  let dbLatencyMs = 0;
  let dbError: string | undefined;

  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - dbStart;
  } catch (err) {
    dbLatencyMs = Date.now() - dbStart;
    dbStatus = "error";
    dbError = err instanceof Error ? err.message : "Unknown database error";
  }

  // ------------------------------------------------------------------
  // CSV staleness check (only when DB is reachable)
  // ------------------------------------------------------------------
  let csvStatus: HealthStatus = "ok";
  let csvSummary = {
    staleCount: 0,
    totalCount: 0,
    stalePercent: 0,
    warning: "",
  };

  if (dbStatus !== "error") {
    try {
      const registrations = await prisma.registration.findMany({
        where: { deletedAt: null },
        include: { user: { select: { githubUsername: true } } },
        orderBy: { updatedAt: "desc" },
      });

      const rows = registrations.map(toContributorRow);
      const summary = buildStalenessSummary(rows);

      csvSummary = {
        staleCount: summary.staleCount,
        totalCount: summary.totalCount,
        stalePercent: summary.stalePercent,
        warning: summary.warning,
      };

      if (summary.stale) {
        csvStatus = "degraded";
      }
    } catch {
      // Non-fatal: if the staleness query fails we mark degraded but don't
      // escalate to error (the DB ping above already covers connectivity).
      csvStatus = "degraded";
      csvSummary.warning =
        "Unable to determine CSV staleness. Re-check contributor data before exporting.";
    }
  }

  // ------------------------------------------------------------------
  // Contract-to-Postgres sync job status
  // ------------------------------------------------------------------
  const lastSync = getContractSyncHealth();
  const contractSyncStatus: HealthStatus =
    lastSync?.status === "error" ? "degraded" : "ok";

  // ------------------------------------------------------------------
  // Overall status
  // ------------------------------------------------------------------
  let overallStatus: HealthStatus = "ok";
  if (dbStatus === "error") {
    overallStatus = "error";
  } else if (csvStatus === "degraded" || contractSyncStatus === "degraded") {
    overallStatus = "degraded";
  }

  const body: HealthResponse = {
    status: overallStatus,
    timestamp,
    checks: {
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        ...(dbError ? { error: dbError } : {}),
      },
      csvStaleness: {
        status: csvStatus,
        ...csvSummary,
      },
      contractSync: {
        status: contractSyncStatus,
        lastRunAt: lastSync?.startedAt ?? null,
        ...(lastSync?.errors?.length
          ? { lastError: lastSync.errors.join("; ") }
          : {}),
      },
    },
    version,
  };

  return withPublicCors(NextResponse.json(body, { status: 200 }));
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
}
