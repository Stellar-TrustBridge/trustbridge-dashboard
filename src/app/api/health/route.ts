import { NextResponse } from "next/server";

import { getContractSyncHealth } from "@/lib/contract-sync";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { toContributorRow } from "@/lib/registrations";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";
import { runHealthChecks } from "@/lib/health";
export type { HealthStatus, HealthResponse } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 *
 * Health logic lives in src/lib/health.ts so the status page can import it
 * directly and avoid an HTTP self-call. (#308)
 */
export async function GET() {
  const body = await runHealthChecks();
  return NextResponse.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
    },
    version,
  };

  return withPublicCors(NextResponse.json(body, { status: 200 }));
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
  });
}
