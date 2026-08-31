import { NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { getRecentAuditLog } from "@/lib/audit";
import { getContributors } from "@/lib/registrations";
import { summarizeContributors, computeHorizonLatencyStats } from "@/lib/stats";
import { checkAddressChangeAnomaly } from "@/lib/address-anomaly";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics
 *
 * Returns a lightweight admin metrics snapshot for the maintainer dashboard:
 * - contributor readiness counts
 * - horizon latency statistics (p50, p95, avg)
 * - mass address change anomaly detection
 * - recent audit log summary (last 50 entries)
 * - circuit-breaker & rate-limit env configuration
 *
 * Requires an authenticated maintainer session.
 */
export async function GET() {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Contributor readiness snapshot
  const { contributors } = await getContributors();
  const readinessSummary = summarizeContributors(contributors);

  const byStatus = {
    ready: contributors.filter((c) => c.readiness === "ready").length,
    low_reserve: contributors.filter((c) => c.readiness === "low_reserve").length,
    not_ready: contributors.filter((c) => c.readiness === "not_ready").length,
  };

  // Horizon latency snapshot
  const latencyRecords = await prisma.registration.findMany({
    select: { horizonLatencyMs: true },
  });
  const horizonLatency = computeHorizonLatencyStats(
    latencyRecords.map((r) => r.horizonLatencyMs)
  );

  // Address change anomaly snapshot
  const addressAnomaly = await checkAddressChangeAnomaly();

  // Recent audit log activity
  const auditEntries = await getRecentAuditLog(50);
  const auditByAction: Record<string, number> = {};
  for (const entry of auditEntries) {
    auditByAction[entry.action] = (auditByAction[entry.action] ?? 0) + 1;
  }

  // Expose configured operational limits (no secrets)
  const operationalConfig = {
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 10),
    circuitBreakerFailureThreshold: Number(
      process.env.HORIZON_CB_FAILURE_THRESHOLD ?? 5
    ),
    circuitBreakerRecoveryMs: Number(process.env.HORIZON_CB_RECOVERY_MS ?? 30_000),
    staleCsvMaxAgeMs: Number(process.env.STALE_CSV_MAX_AGE_MS ?? 86_400_000),
    horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon.stellar.org",
    sorobanContractConfigured: Boolean(process.env.SOROBAN_CONTRACT_ID),
  };

  return NextResponse.json({
    contributors: {
      total: readinessSummary.totalContributors,
      ready: readinessSummary.readyCount,
      readyPercent: readinessSummary.readyPercent,
      byStatus,
    },
    horizonLatency,
    addressAnomaly,
    audit: {
      recentEntries: auditEntries.length,
      byAction: auditByAction,
      latestAt: auditEntries[0]?.createdAt ?? null,
    },
    config: operationalConfig,
  });
}
