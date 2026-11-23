import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

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
  /** Number of active sessions revoked on member_removed (0 for all other actions). */
  sessionsRevoked?: number;
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
// Session revocation
// ---------------------------------------------------------------------------

/**
 * Immediately revoke all active NextAuth `Session` rows for a given
 * GitHub login.
 *
 * The dashboard uses JWT sessions by default (no server-side `Session` row),
 * but the NextAuth Prisma adapter creates `Session` rows when database
 * sessions are enabled.  Deleting the rows forces every future request that
 * resolves a session token to find nothing — the user is signed out on the
 * next request regardless of whether the JWT has not yet expired.
 *
 * Design decisions:
 * - **Lookup by githubUsername, not githubId** — the webhook payload carries
 *   a login string; we do a case-insensitive match so a username that changed
 *   capitalisation is still revoked.
 * - **deleteMany, not deleteOne** — a user may have concurrent sessions from
 *   multiple browsers or devices.  All are revoked atomically so no lingering
 *   session survives a race where one tab is mid-request.
 * - **Never throws** — a Prisma error must not block the webhook response or
 *   leave the audit log silent; callers should handle failures via the return
 *   value and audit trail.
 *
 * Returns the number of sessions deleted, or -1 on error (error is logged).
 */
export async function revokeSessionsForUser(login: string): Promise<number> {
  if (!login || typeof login !== "string" || login.trim().length === 0) {
    return 0;
  }

  const normalizedLogin = login.trim().toLowerCase();

  try {
    // Resolve the user id first so we can target the Session foreign key
    // exactly, without relying on a cascading join through prisma.session.
    const user = await prisma.user.findFirst({
      where: {
        githubUsername: { equals: normalizedLogin, mode: "insensitive" },
      },
      select: { id: true },
    });

    if (!user) {
      // No matching user — nothing to revoke, not an error.
      return 0;
    }

    const result = await prisma.session.deleteMany({
      where: { userId: user.id },
    });

    return result.count;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[webhook] revokeSessionsForUser failed:", message);
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Event processor
// ---------------------------------------------------------------------------

/**
 * Process a `membership` GitHub organization event.
 *
 * - `member_added` / `member_invited`: ensures a User row exists for the
 *   GitHub login so the contributor can register immediately after joining.
 * - `member_removed`: revokes all active dashboard sessions for the removed
 *   user so access is terminated promptly, without waiting for JWT expiry.
 *   The user record and registration data are preserved — the maintainer
 *   decides whether to fully delete the account.
 *
 * All outcomes are appended to the audit log for traceability.
 * The function never throws; unhandled actions are logged and returned with
 * `handled: false`.
 */
export async function processGithubOrgMembershipEvent(
  payload: GithubOrgMembershipPayload
): Promise<ProcessEventResult> {
  const action = payload.action ?? "unknown";
  const login = payload.membership?.user?.login ?? null;
  const githubId = payload.membership?.user?.id?.toString() ?? null;
  const org = payload.organization?.login ?? null;

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
      metadata: { org, role: payload.membership?.role ?? null },
    });

    return { handled: true, action, login, sessionsRevoked: 0 };
  }

  if (action === "member_removed") {
    // Revoke sessions before writing the audit log so a concurrent request
    // that checks the audit log cannot infer whether the session deletion
    // succeeded or failed independently.
    let sessionsRevoked = 0;
    if (login) {
      sessionsRevoked = await revokeSessionsForUser(login);
    }

    await recordAuditLog({
      action: "webhook.github_org_membership.member_removed",
      actorLogin: payload.sender?.login ?? null,
      targetLabel: login,
      metadata: {
        org,
        sessionsRevoked: sessionsRevoked >= 0 ? sessionsRevoked : null,
        revocationError: sessionsRevoked === -1 ? true : undefined,
      },
    });

    return { handled: true, action, login, sessionsRevoked };
  }

  // Unrecognised action — log for visibility, return unhandled.
  await recordAuditLog({
    action: "webhook.github_org_membership.unknown_action",
    actorLogin: payload.sender?.login ?? null,
    targetLabel: login,
    metadata: { action, org },
  });

  return { handled: false, action, login, sessionsRevoked: 0 };
}
