import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { buildBanEmail, sendEmailNotification } from "@/lib/email";

export interface BanStatus {
  banned: boolean;
  reason?: string;
  bannedAt?: Date;
}

export type BanAppealOutcome = "pending" | "approved" | "denied";

export interface BanAppealNote {
  id: string;
  githubUsername: string;
  note: string;
  outcome: BanAppealOutcome;
  actorId: string;
  actorLogin?: string | null;
  createdAt: Date;
}

/**
 * Stable, auditable reason surfaced to banned contributors on register/check.
 * Kept generic so internal moderation notes are not leaked to the caller.
 */
export const BAN_ENFORCE_REASON = "Contributor is banned from Wave registries";

export interface BanEnforcement {
  allowed: boolean;
  reason?: string;
  bannedAt?: Date;
}

const BAN_APPEAL_OUTCOMES: readonly BanAppealOutcome[] = ["pending", "approved", "denied"];

/**
 * Stable reason codes for ban/unban failures (issue #660).
 * Callers map these to HTTP status codes; audit trails always record them.
 */
export type BanServiceErrorCode =
  | "SELF_UNBAN_FORBIDDEN"
  | "SELF_BAN_FORBIDDEN"
  | "REASON_REQUIRED"
  | "INVALID_APPEAL_OUTCOME"
  | "EMPTY_BULK_BAN"
  | "BULK_BAN_TOO_LARGE";

export class BanServiceError extends Error {
  readonly code: BanServiceErrorCode;

  constructor(code: BanServiceErrorCode, message: string) {
    super(message);
    this.name = "BanServiceError";
    this.code = code;
  }
}

/**
 * Maximum number of handles accepted in a single bulk ban request (issue #780).
 * Oversized batches fail closed with `BULK_BAN_TOO_LARGE` rather than partially
 * applying, so operators must split the request deliberately.
 */
export const BULK_BAN_MAX_HANDLES = 100;

/**
 * Per-handle outcome in a bulk ban dry-run report (issue #780).
 * - `would-ban`: handle is not currently banned and would be banned.
 * - `already-banned`: handle already has an active ban; no change.
 * - `skipped`: handle was empty/duplicate after normalization.
 */
export type BulkBanDryRunOutcome = "would-ban" | "already-banned" | "skipped";

export interface BulkBanDryRunEntry {
  githubUsername: string;
  outcome: BulkBanDryRunOutcome;
}

/**
 * Stable, machine-readable dry-run report. Never mutates ban state; callers can
 * surface counts to operators before committing a real bulk ban.
 */
export interface BulkBanDryRunReport {
  dryRun: true;
  total: number;
  wouldBan: number;
  alreadyBanned: number;
  skipped: number;
  entries: BulkBanDryRunEntry[];
}

function normalizeActorLogin(actorLogin?: string | null): string | null {
  const trimmed = (actorLogin ?? "").trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/**
 * Rejects self-moderation: an actor may not ban or unban their own handle.
 * Case-insensitive; a missing actor login skips the check (system/CI actors).
 */
function assertNotSelfModeration(
  normalizedUsername: string,
  actorId: string,
  actorLogin: string | null,
  action: "ban" | "unban"
): void {
  const selfCode =
    action === "unban" ? "SELF_UNBAN_FORBIDDEN" : "SELF_BAN_FORBIDDEN";
  const selfMessage =
    action === "unban"
      ? "Maintainers cannot unban their own account."
      : "Maintainers cannot ban their own account.";

  if (actorLogin && actorLogin === normalizedUsername) {
    throw new BanServiceError(selfCode, selfMessage);
  }
  // actorId is compared later against the resolved user id (same handle).
  void actorId;
}

/**
 * Case-insensitive check if a contributor or GitHub handle is banned.
 */
export async function isUserBanned(
  userId?: string | null,
  githubUsername?: string | null
): Promise<BanStatus> {
  if (!userId && !githubUsername) {
    return { banned: false };
  }

  try {
    // Check by user ID if provided
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { banned: true, banReason: true, bannedAt: true, githubUsername: true },
      });
      if (user?.banned) {
        return {
          banned: true,
          reason: user.banReason ?? "Account is suspended",
          bannedAt: user.bannedAt ?? undefined,
        };
      }
      if (!githubUsername && user?.githubUsername) {
        githubUsername = user.githubUsername;
      }
    }

    // Case-insensitive check on BannedContributor table
    if (githubUsername) {
      const lowerUsername = githubUsername.trim().toLowerCase();
      const bannedRecord = await prisma.bannedContributor.findFirst({
        where: {
          githubUsername: {
            equals: lowerUsername,
            mode: "insensitive",
          },
        },
      });

      if (bannedRecord) {
        return {
          banned: true,
          reason: bannedRecord.reason,
          bannedAt: bannedRecord.createdAt,
        };
      }
    }

    return { banned: false };
  } catch (error) {
    console.error("Failed to check user ban status:", error);
    // Fail open or closed depending on security requirement - fail safe by allowing if DB error, but logging
    return { banned: false };
  }
}

/**
 * Single enforce path used by register and check APIs. Resolves ban status via
 * `isUserBanned` and returns a stable, auditable decision. Internal ban notes
 * are never surfaced; callers receive `BAN_ENFORCE_REASON` instead.
 */
export async function enforceBan({
  userId,
  githubUsername,
}: {
  userId?: string | null;
  githubUsername?: string | null;
}): Promise<BanEnforcement> {
  const status = await isUserBanned(userId, githubUsername);
  if (!status.banned) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: BAN_ENFORCE_REASON,
    bannedAt: status.bannedAt,
  };
}

/**
 * Normalizes a raw list of handles for bulk operations: trims, lowercases,
 * drops empties, and de-duplicates while preserving first-seen order.
 * Returns the normalized handles plus the count of skipped raw entries.
 */
function normalizeBulkHandles(rawHandles: readonly string[]): {
  handles: string[];
  skipped: number;
} {
  const seen = new Set<string>();
  const handles: string[] = [];
  let skipped = 0;

  for (const raw of rawHandles) {
    const normalized = (raw ?? "").trim().toLowerCase();
    if (normalized === "" || seen.has(normalized)) {
      skipped += 1;
      continue;
    }
    seen.add(normalized);
    handles.push(normalized);
  }

  return { handles, skipped };
}

/**
 * Bulk ban dry-run (issue #780). Computes a would-affect report without
 * mutating any ban state. Fails closed on empty or oversized input with stable
 * reason codes so operators get actionable errors instead of silent success.
 */
export async function dryRunBulkBan({
  githubUsernames,
}: {
  githubUsernames: readonly string[];
}): Promise<BulkBanDryRunReport> {
  if (!Array.isArray(githubUsernames) || githubUsernames.length === 0) {
    throw new BanServiceError(
      "EMPTY_BULK_BAN",
      "At least one GitHub handle is required for a bulk ban dry-run."
    );
  }
  if (githubUsernames.length > BULK_BAN_MAX_HANDLES) {
    throw new BanServiceError(
      "BULK_BAN_TOO_LARGE",
      `Bulk ban accepts at most ${BULK_BAN_MAX_HANDLES} handles per request.`
    );
  }

  const { handles, skipped } = normalizeBulkHandles(githubUsernames);

  const entries: BulkBanDryRunEntry[] = [];
  let wouldBan = 0;
  let alreadyBanned = 0;

  for (const githubUsername of handles) {
    const status = await isUserBanned(null, githubUsername);
    if (status.banned) {
      alreadyBanned += 1;
      entries.push({ githubUsername, outcome: "already-banned" });
    } else {
      wouldBan += 1;
      entries.push({ githubUsername, outcome: "would-ban" });
    }
  }

  return {
    dryRun: true,
    total: handles.length,
    wouldBan,
    alreadyBanned,
    skipped,
    entries,
  };
}

/**
 * Bans a contributor by GitHub handle with a mandatory reason.
 */
export async function banContributor({
  githubUsername,
  reason,
  actorId,
  actorLogin,
  locale,
}: {
  githubUsername: string;
  reason: string;
  actorId: string;
  actorLogin?: string | null;
  locale?: string;
}) {
  const normalizedUsername = githubUsername.trim().toLowerCase();
  const trimmedReason = reason.trim();
  const login = normalizeActorLogin(actorLogin);

  if (!trimmedReason) {
    throw new BanServiceError(
      "REASON_REQUIRED",
      "A reason is required to ban a contributor."
    );
  }
  assertNotSelfModeration(normalizedUsername, actorId, login, "ban");

  // Update existing user if present
  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  if (user && user.id === actorId) {
    throw new BanServiceError(
      "SELF_BAN_FORBIDDEN",
      "Maintainers cannot ban their own account."
    );
  }

  // Atomic multi-step write: user flag + persistent ban row move together so a
  // concurrent unban cannot observe a half-applied ban (issue #660).
  await prisma.$transaction([
    ...(user
      ? [
          prisma.user.update({
            where: { id: user.id },
            data: {
              banned: true,
              bannedAt: new Date(),
              banReason: trimmedReason,
              bannedById: actorId,
            },
          }),
        ]
      : []),
    prisma.bannedContributor.upsert({
      where: { githubUsername: normalizedUsername },
      create: {
        githubUsername: normalizedUsername,
        reason: trimmedReason,
        bannedById: actorId,
      },
      update: {
        reason: trimmedReason,
        bannedById: actorId,
      },
    }),
  ]);

  // Log audit event
  await recordAuditLog({
    action: "contributor.banned",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      reason: trimmedReason,
      githubUsername: normalizedUsername,
    },
  });

  let emailSent = false;
  if (user?.email) {
    try {
      const template = buildBanEmail({
        githubUsername: normalizedUsername,
        reason: trimmedReason,
        locale,
      });
      emailSent = await sendEmailNotification({ to: user.email, ...template });
    } catch (error) {
      console.error("Failed to build or send contributor ban notice:", error);
    }
  }

  return {
    success: true,
    githubUsername: normalizedUsername,
    reason: trimmedReason,
    emailSent,
  };
}

/**
 * Unbans a contributor by GitHub handle.
 */
export async function unbanContributor({
  githubUsername,
  actorId,
  actorLogin,
  reason,
}: {
  githubUsername: string;
  actorId: string;
  actorLogin?: string | null;
  reason?: string;
}) {
  const normalizedUsername = githubUsername.trim().toLowerCase();
  const login = normalizeActorLogin(actorLogin);

  assertNotSelfModeration(normalizedUsername, actorId, login, "unban");

  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  if (user && user.id === actorId) {
    throw new BanServiceError(
      "SELF_UNBAN_FORBIDDEN",
      "Maintainers cannot unban their own account."
    );
  }

  await prisma.$transaction([
    ...(user
      ? [
          prisma.user.update({
            where: { id: user.id },
            data: {
              banned: false,
              bannedAt: null,
              banReason: null,
              bannedById: null,
            },
          }),
        ]
      : []),
    prisma.bannedContributor.deleteMany({
      where: {
        githubUsername: {
          equals: normalizedUsername,
          mode: "insensitive",
        },
      },
    }),
  ]);

  await recordAuditLog({
    action: "contributor.unbanned",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      reason: reason?.trim() || null,
      githubUsername: normalizedUsername,
    },
  });

  return {
    success: true,
    githubUsername: normalizedUsername,
  };
}
