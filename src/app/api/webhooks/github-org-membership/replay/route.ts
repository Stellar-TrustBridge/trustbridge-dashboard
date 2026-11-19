import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  processGithubOrgMembershipEvent,
  verifyWebhookSignature,
  type GithubOrgMembershipPayload,
} from "@/lib/github-org-membership-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await request.text();
  const verification = verifyWebhookSignature(
    rawBody,
    request.headers.get("x-hub-signature-256")
  );
  if (!verification.ok) {
    return NextResponse.json(
      { error: "Unauthorized", reason: verification.reason },
      { status: 401 }
    );
  }

  let payload: GithubOrgMembershipPayload;
  try {
    payload = JSON.parse(rawBody) as GithubOrgMembershipPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const result = await processGithubOrgMembershipEvent(payload, deliveryId);

  return NextResponse.json({ ok: true, replayed: true, ...result });
}
