import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { CacheStore } from "@/lib/cache";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrgMembershipAction = "member_added" | "member_removed" | "member_invited";

export interface GithubOrgMembershipPayload {
  action: OrgMembershipAction | string;
  membership?: {
    user?: { id?: number; login?: string };
    role?: string;
    state?: string;
  };
  organization?: { login?: string };
  sender?: { login?: string };
}

export interface WebhookVerificationResult {
  ok: boolean;
  reason?: string;
}

export interface ProcessEventResult {
  handled: boolean;
  action: string;
  login: string | null;
  deliveryId?: string | null;
  duplicate?: boolean;
}

const WEBHOOK_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

export const webhookDeliveryCache = new CacheStore<{
  deliveryId: string;
  processedAt: number;
}>(WEBHOOK_DELIVERY_TTL_MS);

function normalizeDeliveryId(deliveryId: string | null | undefined): string | null {
  const normalized = deliveryId?.trim();
  return normalized || null;
}

function deliveryCacheKey(deliveryId: string): string {
  return `github-org-membership:delivery:${deliveryId}`;
}

export function isDuplicateWebhookDelivery(
  deliveryId: string | null | undefined,
): boolean {
  const normalized = normalizeDeliveryId(deliveryId);
  if (!normalized) return false;
  return webhookDeliveryCache.get(deliveryCacheKey(normalized)) !== null;
}

export function markWebhookDeliveryProcessed(
  deliveryId: string | null | undefined,
): void {
  const normalized = normalizeDeliveryId(deliveryId);
  if (!normalized) return;
  webhookDeliveryCache.set(deliveryCacheKey(normalized), {
    deliveryId: normalized,
    processedAt: Date.now(),
  });
}

export function resetWebhookDeliveryCache(): void {
  webhookDeliveryCache.clear();
}

const orgMembershipCache = new Map<string, boolean>();

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function isCachedOrgMember(login: string): boolean | undefined {
  return orgMembershipCache.get(normalizeLogin(login));
}

export function updateOrgMembershipCache(
  action: OrgMembershipAction | string,
  login: string | null | undefined,
): void {
  if (!login?.trim()) return;
  if (action === "member_added" || action === "member_invited") {
    orgMembershipCache.set(normalizeLogin(login), true);
  } else if (action === "member_removed") {
    orgMembershipCache.set(normalizeLogin(login), false);
  }
}

export function resetOrgMembershipCache(): void {
  orgMembershipCache.clear();
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * GitHub sends the signature as `sha256=<hex>` in the
 * `x-hub-signature-256` header.  We recompute the HMAC over the raw body
 * and compare with a constant-time equality check to resist timing attacks.
 *
 * Returns `{ ok: false }` (never throws) so callers can always branch on the
 * result without wrapping in try/catch.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): WebhookVerificationResult {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return { ok: false, reason: "GITHUB_WEBHOOK_SECRET is not configured" };
  }

  if (!signatureHeader) {
    return { ok: false, reason: "Missing x-hub-signature-256 header" };
  }

  const [scheme, receivedHex] = signatureHeader.split("=");
  if (scheme !== "sha256" || !receivedHex) {
    return { ok: false, reason: "Unexpected signature scheme (expected sha256=...)" };
  }

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Validate the hex encoding BEFORE converting: Buffer.from(hex, "hex")
  // silently drops a trailing nibble on odd-length input, which would let a
  // "<digest>a" signature pass the byte-length guard below. Compare on the
  // hex strings so any length or charset deviation fails closed.
  if (
    receivedHex.length !== expectedHex.length ||
    !/^[0-9a-fA-F]+$/.test(receivedHex)
  ) {
    return { ok: false, reason: "Signature length mismatch" };
  }

  // Use timingSafeEqual to prevent timing-oracle attacks.
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");

  const match = timingSafeEqual(expected, received);
  return match ? { ok: true } : { ok: false, reason: "Signature mismatch" };
}

// ---------------------------------------------------------------------------
// Event processor
// ---------------------------------------------------------------------------

/**
 * Process a `membership` GitHub organization event.
 *
 * - `member_added` / `member_invited`: ensures a User row exists for the
 *   GitHub login so the contributor can register immediately after joining.
 * - `member_removed`: marks the registration as needing a re-check (does not
 *   delete data — the maintainer decides what to do).
 *
 * All outcomes are appended to the audit log for traceability.
 * The function never throws; unhandled actions are logged and returned with
 * `handled: false`.
 */
export async function processGithubOrgMembershipEvent(
  payload: GithubOrgMembershipPayload,
  deliveryId?: string | null,
): Promise<ProcessEventResult> {
  const action = payload.action ?? "unknown";
  const login = payload.membership?.user?.login ?? null;
  const githubId = payload.membership?.user?.id?.toString() ?? null;
  const org = payload.organization?.login ?? null;
  const delivery = normalizeDeliveryId(deliveryId);

  if (isDuplicateWebhookDelivery(delivery)) {
    return { handled: false, action, login, deliveryId: delivery, duplicate: true };
  }
  markWebhookDeliveryProcessed(delivery);
  updateOrgMembershipCache(action, login);

  if (action === "member_added" || action === "member_invited") {
    if (login && githubId) {
      // Upsert so we don't duplicate rows if the user signed in before the
      // webhook fires (race-condition safe).
      await prisma.user.upsert({
        where: { githubId },
        create: {
          githubId,
          githubUsername: login,
        },
        update: {
          githubUsername: login,
        },
      });
    }

    await recordAuditLog({
      action: `webhook.github_org_membership.${action}`,
      actorLogin: payload.sender?.login ?? null,
      targetLabel: login,
      metadata: { org, role: payload.membership?.role ?? null, deliveryId: delivery },
    });

    return { handled: true, action, login, deliveryId: delivery };
  }

  if (action === "member_removed") {
    await recordAuditLog({
      action: "webhook.github_org_membership.member_removed",
      actorLogin: payload.sender?.login ?? null,
      targetLabel: login,
      metadata: { org, deliveryId: delivery },
    });

    return { handled: true, action, login, deliveryId: delivery };
  }

  // Unrecognised action — log for visibility, return unhandled.
  await recordAuditLog({
    action: "webhook.github_org_membership.unknown_action",
    actorLogin: payload.sender?.login ?? null,
    targetLabel: login,
    metadata: { action, org, deliveryId: delivery },
  });

  return { handled: false, action, login, deliveryId: delivery };
}
