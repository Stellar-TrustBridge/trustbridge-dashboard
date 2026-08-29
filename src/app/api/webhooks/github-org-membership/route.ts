import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface GitHubMembershipEvent {
  action: "added" | "deleted";
  member: {
    login: string;
    id: number;
  };
  organization: {
    login: string;
  };
  sender: {
    login: string;
  };
}

/**
 * Verifies the GitHub webhook signature to ensure the request is authentic.
 * GitHub sends X-Hub-Signature-256 with each webhook.
 */
export function verifyWebhookSignature(
  payload: Buffer,
  signature: string | undefined,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.warn(
      "GITHUB_WEBHOOK_SECRET not configured — webhook signature verification skipped",
    );
    return false;
  }

  if (!signature) {
    console.warn("Missing X-Hub-Signature-256 header");
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const digest = `sha256=${hmac.digest("hex")}`;

  const digestBuf = Buffer.from(digest);
  const signatureBuf = Buffer.from(signature);
  if (digestBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(digestBuf, signatureBuf);
}

export async function processGithubOrgMembershipEvent(
  event: GitHubMembershipEvent,
  requestHeaders: Headers,
): Promise<{ status: "accepted" | "ignored"; event: Record<string, unknown> }> {
  const { action, member, organization, sender } = event;
  const maintainerOrg = process.env.GITHUB_MAINTAINER_ORG?.trim();

  if (
    !maintainerOrg ||
    organization.login.toLowerCase() !== maintainerOrg.toLowerCase()
  ) {
    return {
      status: "ignored",
      event: {
        webhook: "github.organization.member",
        action,
        member: member.login,
        actor: sender.login,
        org: organization.login,
        timestamp: new Date().toISOString(),
      },
    };
  }

  const eventLog = {
    webhook: "github.organization.member",
    action,
    member: member.login,
    actor: sender.login,
    org: organization.login,
    timestamp: new Date().toISOString(),
  };

  console.log("Webhook received:", eventLog);

  if (action === "added" || action === "deleted") {
    const user = await prisma.user.findUnique({
      where: { githubUsername: member.login },
    });

    if (user) {
      await recordAuditLog({
        action: "webhook.org_membership_changed",
        actorId: null,
        actorLogin: sender.login,
        targetId: user.id,
        targetLabel: member.login,
        metadata: {
          membershipAction: action,
          org: organization.login,
          webhookId: requestHeaders.get("X-GitHub-Delivery") || "unknown",
        },
      });

      console.log(
        `Org membership sync: ${member.login} ${action} from ${organization.login}`,
      );
    } else {
      console.log(
        `User not found in database: ${member.login} (may not have registered yet)`,
      );
    }
  }

  return {
    status: "accepted",
    event: eventLog,
  };
}

/**
 * GitHub organization membership webhook handler.
 * Syncs org membership changes to update maintainer access.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.arrayBuffer();
    const payload = Buffer.from(body);

    const signature = request.headers.get("X-Hub-Signature-256") || undefined;
    if (!verifyWebhookSignature(payload, signature)) {
      console.warn("Webhook signature verification failed");
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const event: GitHubMembershipEvent = JSON.parse(payload.toString("utf-8"));
    const result = await processGithubOrgMembershipEvent(event, request.headers);

    return NextResponse.json(
      {
        status: result.status,
        event: result.event,
      },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook processing failed";
    console.error("Webhook error:", message);

    return NextResponse.json(
      {
        status: "error",
        message,
      },
      { status: 202 },
    );
  }
}
