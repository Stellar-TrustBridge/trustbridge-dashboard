import { NextResponse } from "next/server";

import { getContractSyncHealth } from "@/lib/contract-sync";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { toContributorRow } from "@/lib/registrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: { status: HealthStatus; latencyMs: number; error?: string };
    horizon: { status: HealthStatus; latencyMs: number };
    sorobanRpc: { status: HealthStatus; latencyMs: number };
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
 * Probe Horizon by hitting /fee_stats — lightweight, no auth, always available.
 * Returns { ok, latencyMs } without leaking the configured URL.
 */
async function probeHorizon(): Promise<{ ok: boolean; latencyMs: number }> {
  const url =
    (process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || "https://horizon.stellar.org") +
    "/fee_stats";
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/**
 * Probe Soroban RPC by sending a minimal getHealth JSON-RPC call.
 */
async function probeSorobanRpc(): Promise<{ ok: boolean; latencyMs: number }> {
  const url =
    process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    if (!res.ok) return { ok: false, latencyMs: Date.now() - start };
    const json = (await res.json()) as { result?: { status?: string } };
    return { ok: json.result?.status === "healthy", latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
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
 * - `"ok"`       — all checks healthy
 * - `"degraded"` — database reachable but a sub-check is unhealthy
 * - `"error"`    — database unreachable (critical)
 *
 * The response is intentionally unauthenticated so monitoring tools can poll
 * it without credentials. **No internal URLs or PII are exposed** — only
 * booleans, latencies, and counts.
 *
 * Cached for 30 s at the CDN layer to absorb monitoring poll bursts.
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const timestamp = new Date().toISOString();
  const version = process.env.npm_package_version ?? "0.1.0";

  // Run independent checks in parallel
  const [horizonProbe, rpcProbe] = await Promise.all([
    probeHorizon(),
    probeSorobanRpc(),
  ]);

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
  // Horizon + Soroban RPC checks
  // ------------------------------------------------------------------
  const horizonStatus: HealthStatus = horizonProbe.ok ? "ok" : "degraded";
  const rpcStatus: HealthStatus = rpcProbe.ok ? "ok" : "degraded";

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
  } else if (
    csvStatus === "degraded" ||
    contractSyncStatus === "degraded" ||
    horizonStatus === "degraded" ||
    rpcStatus === "degraded"
  ) {
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
      horizon: {
        status: horizonStatus,
        latencyMs: horizonProbe.latencyMs,
      },
      sorobanRpc: {
        status: rpcStatus,
        latencyMs: rpcProbe.latencyMs,
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

  return NextResponse.json(body, {
    status: 200,
    headers: {
      // 30 s public cache — absorbs monitoring bursts, stays fresh enough
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
  });
}
