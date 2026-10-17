import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";

export interface InviteRecord {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
}

/**
 * Hash an invite token using SHA-256.
 * Only the hash is persisted — the raw token is shown to the inviter exactly
 * once and never stored in plaintext.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Generate a cryptographically random invite token (URL-safe base64, 32 bytes
 * of entropy) and return both the raw token (to show the inviter) and its hash
 * (to persist in the database).
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}

/**
 * Retrieve all invite records, newest first.
 * Returns an empty array when no invites exist rather than throwing.
 */
export async function listInvites(): Promise<InviteRecord[]> {
  const rows = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows as InviteRecord[];
}

/**
 * Delete an invite by its database id.
 * Returns `true` when a record was deleted, `false` when the id was not found.
 * Never throws on a missing record — callers can treat both outcomes cleanly.
 */
export async function deleteInvite(id: string): Promise<boolean> {
  try {
    await prisma.invite.delete({ where: { id } });
    return true;
  } catch {
    // Prisma throws P2025 when the record doesn't exist; treat as not-found.
    return false;
  }
}

/**
 * Find an invite by its hashed token.
 * Returns `null` when no matching record is found.
 */
export async function findInviteByToken(
  rawToken: string
): Promise<InviteRecord | null> {
  const tokenHash = hashInviteToken(rawToken);
  const row = await prisma.invite.findFirst({ where: { tokenHash } });
  return (row as InviteRecord | null) ?? null;
}
