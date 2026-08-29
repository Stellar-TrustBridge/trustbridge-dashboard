import { NextRequest, NextResponse } from "next/server";

import { refreshMaintainerSession, requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getRegistryMode } from "@/lib/registry-mode";
import { getContributors } from "@/lib/registrations";
import { backgroundQueue } from "@/lib/background-queue";
import { captureException } from "@/lib/sentry";
import type { ReadinessStatus } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_READINESS_FILTERS = new Set<ReadinessStatus>([
  "ready",
  "low_reserve",
  "not_ready",
]);

export async function GET(request: NextRequest) {
  if (!(await refreshMaintainerSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const readinessParam = request.nextUrl.searchParams.get("readiness");

  if (
    readinessParam !== null &&
    !VALID_READINESS_FILTERS.has(readinessParam as ReadinessStatus)
  ) {
    return NextResponse.json(
      {
        error: `Invalid readiness filter "${readinessParam}". Must be one of: ${Array.from(
          VALID_READINESS_FILTERS
        ).join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const { contributors: allContributors, total } = await getContributors();

    const contributors =
      readinessParam !== null
        ? allContributors.filter((c) => c.readiness === readinessParam)
        : allContributors;

    return NextResponse.json({
      contributors,
      total,
      filtered: contributors.length,
      registryMode: getRegistryMode(),
      ...(readinessParam !== null ? { readiness: readinessParam } : {}),
    });
  } catch (error) {
    captureException(error, {
      route: "/api/contributors",
      method: "GET",
      readinessFilter: readinessParam,
    });
    return NextResponse.json(
      { error: "Failed to load contributors" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Gated behind the `batch_recheck` feature flag (issue #201). A full batch
  // recheck fans out one Horizon call per contributor, so it is a risky write
  // that fails closed when the flag source is unreachable.
  if (!(await isFeatureEnabled("batch_recheck"))) {
    return NextResponse.json(
      { error: "Batch recheck is currently disabled" },
      { status: 403 }
    );
  }

  try {
    const jobId = await backgroundQueue.enqueue(
      "recheck.batch",
      {},
      session.user.id
    );

    await recordAuditLog({
      action: "recheck.batch.queued",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      metadata: {
        jobId,
      },
    });

    return NextResponse.json({
      jobId,
      status: "pending",
      message: "Batch recheck enqueued. Poll /api/contributors/queue/jobs/" + jobId + " for progress.",
    });
  } catch (error) {
    captureException(error, {
      route: "/api/contributors",
      method: "POST",
      operation: "batch-recheck-enqueue",
      actorId: session.user.id,
    });
    return NextResponse.json(
      { error: "Failed to enqueue batch recheck" },
      { status: 500 }
    );
  }
}