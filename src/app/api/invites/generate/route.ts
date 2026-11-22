import { NextRequest, NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { buildInviteEmail, sendEmailNotification } from "@/lib/email";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  createInvite,
  generateInviteCode,
  listInvites,
  revokeInvites,
} from "@/lib/invite-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-org / per-actor invite minting rate limit (issue #715).
// Invite floods create unmanageable Wave registration spam, so we cap how many
// invites a single org/actor can mint within a rolling window. Limits are
// intentionally conservative and documented in docs/SECURITY_POLINRIDER.md.
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const INVITE_RATE_LIMIT_MAX_PER_ORG = 200;
const INVITE_RATE_LIMIT_MAX_PER_ACTOR = 100;

interface RateLimitBucket {
  orgCount: number;
  actorCount: number;
  resetAt: number;
}

// Module-scoped store keyed by org id. In-memory is sufficient for the single
// node runtime used by the dashboard; swap for a shared store if we scale out.
const rateLimitBuckets = new Map<string, RateLimitBucket>();

function checkInviteRateLimit(
  orgId: string,
  actorId: string,
  requested: number,
  now: number
): { allowed: true } | { allowed: false; reason: "rate_limited"; retryAfterSeconds: number } {
  const existing = rateLimitBuckets.get(orgId);
  const bucket: RateLimitBucket =
    existing && existing.resetAt > now
      ? existing
      : { orgCount: 0, actorCount: 0, resetAt: now + INVITE_RATE_LIMIT_WINDOW_MS };

  const nextOrgCount = bucket.orgCount + requested;
  const nextActorCount = bucket.actorCount + requested;

  if (
    nextOrgCount > INVITE_RATE_LIMIT_MAX_PER_ORG ||
    nextActorCount > INVITE_RATE_LIMIT_MAX_PER_ACTOR
  ) {
    rateLimitBuckets.set(orgId, bucket);
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.orgCount = nextOrgCount;
  bucket.actorCount = nextActorCount;
  rateLimitBuckets.set(orgId, bucket);
  return { allowed: true };
}

interface GenerateBulkInvitesRequest {
  count?: number;
  expiryDays?: number;
  recipientEmails?: string[];
  locale?: string;
}

interface GenerateBulkInvitesResponse {
  generated: number;
  invites: Array<{ code: string; createdAt: string; expiresAt: string | null }>;
  emailDelivery?: { sent: number; failed: number };
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireAdmin("invites.generate");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Gated behind the `invite_generation` feature flag (issue #201) so invite
  // issuance can be frozen during a Wave. Risky write → fails closed.
  if (!(await isFeatureEnabled("invite_generation"))) {
    return NextResponse.json(
      { error: "Invite generation is currently disabled" },
      { status: 403 }
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const body = parsedBody as GenerateBulkInvitesRequest;
  const { expiryDays, locale } = body;
  if (
    body.recipientEmails !== undefined &&
    (!Array.isArray(body.recipientEmails) ||
      body.recipientEmails.some((email) => typeof email !== "string"))
  ) {
    return NextResponse.json(
      { error: "recipientEmails must be an array of email addresses" },
      { status: 400 }
    );
  }

  const recipientEmails = body.recipientEmails?.map((email) => email.trim());
  const count = body.count ?? recipientEmails?.length ?? 10;

  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    return NextResponse.json(
      { error: "Count must be between 1 and 1000" },
      { status: 400 }
    );
  }

  if (
    recipientEmails &&
    (recipientEmails.length !== count ||
      recipientEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
  ) {
    return NextResponse.json(
      { error: "Provide one valid recipient email for each invite" },
      { status: 400 }
    );
  }

  if (expiryDays && (expiryDays < 1 || expiryDays > 365)) {
    return NextResponse.json(
      { error: "Expiry days must be between 1 and 365" },
      { status: 400 }
    );
  }

  // Enforce per-org / per-actor invite minting rate limit before any invites
  // are created so a rejected burst leaves no partial privileged state.
  const orgId = session.user.orgId ?? session.user.id;
  const rateLimit = checkInviteRateLimit(orgId, session.user.id, count, Date.now());
  if (!rateLimit.allowed) {
    await recordAuditLog({
      action: "invites.generate_rate_limited",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      metadata: {
        reason: rateLimit.reason,
        requestedCount: count,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
    });
    return NextResponse.json(
      {
        error: "Invite generation rate limit exceeded",
        reason: rateLimit.reason,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  const now = new Date();
  const expiresAt = expiryDays
    ? new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000)
    : null;

  const generatedInvites: Array<{ code: string; createdAt: string; expiresAt: string | null }> = [];
  let emailSent = 0;
  let emailFailed = 0;

  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    const invite = await createInvite({
      code,
      generatedById: session.user.id,
      expiresAt,
    });
    generatedInvites.push({
      code,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt?.toISOString() ?? null,
    });

    const recipientEmail = recipientEmails?.[i];
    if (recipientEmail) {
      try {
        const template = buildInviteEmail({
          inviteCode: code,
          expiresAt,
          locale,
        });
        const sent = await sendEmailNotification({
          to: recipientEmail,
          idempotencyScope: invite.id,
          ...template,
        });
        if (sent) emailSent++;
        else emailFailed++;
      } catch {
        emailFailed++;
      }
    }
  }

  await recordAuditLog({
    action: "invites.bulk_generate",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      count,
      expiryDays: expiryDays ?? null,
      ...(recipientEmails
        ? { emailRecipients: recipientEmails.length, emailSent, emailFailed }
        : {}),
    },
  });

  return NextResponse.json({
    generated: generatedInvites.length,
    invites: generatedInvites,
    ...(recipientEmails ? { emailDelivery: { sent: emailSent, failed: emailFailed } } : {}),
  } satisfies GenerateBulkInvitesResponse);
}

export async function GET(request: NextRequest) {
  const session = await requireAdmin("invites.list");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const pageSize = Math.min(100, parseInt(searchParams.get("pageSize") ?? "20"));

  const result = await listInvites(session.user.id, page, pageSize);

  return NextResponse.json({
    page,
    pageSize,
    totalCount: result.total,
    totalPages: result.totalPages,
    invites: result.invites.map((invite) => ({
      id: invite.id,
      batchLabel: invite.batchLabel,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      used: invite.used,
      usedAt: invite.usedAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString(),
    })),
  });
}

export async function DELETE(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireAdmin("invites.delete");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as { codes: string[] };
  const { codes } = body;

  if (!codes || codes.length === 0) {
    return NextResponse.json(
      { error: "At least one invite code is required" },
      { status: 400 }
    );
  }

  if (codes.length > 1000) {
    return NextResponse.json(
      { error: "Cannot delete more than 1000 invites at once" },
      { status: 400 }
    );
  }

  const { revoked } = await revokeInvites(codes, session.user.id);

  await recordAuditLog({
    action: "invites.bulk_delete",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      requestedCount: codes.length,
      revokedCount: revoked,
    },
  });

  return NextResponse.json({
    deleted: revoked,
  });
}