import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { walletClaimConflictBody } from "@/lib/contributors";
import { checkRateLimit, extractClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-IP rate-limit window for restore operations (ms).
 * Defaults to 10 restores per 60 s to prevent bulk-restore accidents.
 * Override via RESTORE_RATE_LIMIT_WINDOW_MS / RESTORE_RATE_LIMIT_MAX.
 */
function getRestoreRateLimitOptions() {
  const windowMs = Number.parseInt(
    process.env.RESTORE_RATE_LIMIT_WINDOW_MS ?? "60000",
    10
  );
  const maxRequests = Number.parseInt(
    process.env.RESTORE_RATE_LIMIT_MAX ?? "10",
    10
  );
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
    maxRequests:
      Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 10,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // --- Rate limit: prevent accidental bulk restores ---
  const ip = extractClientIp(request);
  const rateLimitKey = `restore:${ip}`;
  const rateLimitOpts = getRestoreRateLimitOptions();
  const rateLimitResult = checkRateLimit(rateLimitKey, rateLimitOpts);
  if (!rateLimitResult.allowed) {
    await recordAuditLog({
      action: "registration.restore.rate_limited",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: params.id,
      metadata: {
        retryAfterSeconds: rateLimitResult.retryAfter,
        ip,
      },
    });
    return NextResponse.json(
      {
        error: "Too many restore requests. Please wait before retrying.",
        code: "RESTORE_RATE_LIMITED",
        retryAfter: rateLimitResult.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimitResult.retryAfter) },
      }
    );
  }

  // --- Dual confirmation: require explicit confirmation flag in body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Request body is required.",
        code: "BODY_REQUIRED",
      },
      { status: 400 }
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    (body as Record<string, unknown>).confirm !== true
  ) {
    return NextResponse.json(
      {
        error:
          'Explicit confirmation required. Send { "confirm": true } to proceed.',
        code: "CONFIRM_REQUIRED",
      },
      { status: 400 }
    );
  }

  const registration = await prisma.registration.findFirst({
    where: {
      id: params.id,
      deletedAt: { not: null },
      ...(session.user.maintainerOrgId
        ? { maintainerOrgId: session.user.maintainerOrgId }
        : {}),
    },
  });
  if (!registration) {
    return NextResponse.json(
      { error: "Deleted registration not found" },
      { status: 404 }
    );
  }

  try {
    const restored = await prisma.registration.update({
      where: { id: params.id },
      data: { deletedAt: null },
    });

    await recordAuditLog({
      action: "registration.restore",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: restored.id,
      targetLabel: restored.stellarAddress,
      metadata: { restoredAt: new Date().toISOString() },
    });

    await invalidateContributorListCaches();

    return NextResponse.json({ success: true, registration: restored });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return NextResponse.json(walletClaimConflictBody(), { status: 409 });
    }
    throw error;
  }
}