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
  | "INVALID_APPEAL_OUTCOME";

export class BanServiceError extends Error {
  readonly code: BanServiceErrorCode;

  constructor(code: BanServiceErrorCode, message: string) {
    super(message);
    this.name = "BanServiceError";
    this.code = code;
  }
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

  // Atomic clear of both ban surfaces so a concurrent ban cannot interleave
  // between the user flag and the persistent BannedContributor row.
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
      reason: reason ?? "Maintainer lifted ban",
      githubUsername: normalizedUsername,
    },
  });

  return { success: true, githubUsername: normalizedUsername };
}

/**
 * Records a ban appeal note with an outcome for a contributor and writes an
 * audit trail entry. Validates inputs before any privileged state is touched so
 * a failure leaves no partial state behind.
 */
export async function addBanAppealNote({
  githubUsername,
  note,
  outcome,
  actorId,
  actorLogin,
}: {
  githubUsername: string;
  note: string;
  outcome: BanAppealOutcome;
  actorId: string;
  actorLogin?: string | null;
}): Promise<BanAppealNote> {
  const normalizedUsername = (githubUsername ?? "").trim().toLowerCase();
  const trimmedNote = (note ?? "").trim();

  if (!normalizedUsername) {
    throw new BanServiceError(
      "REASON_REQUIRED",
      "A githubUsername is required to record a ban appeal note."
    );
  }
  if (!trimmedNote) {
    throw new BanServiceError(
      "REASON_REQUIRED",
      "A note is required to record a ban appeal."
    );
  }
  if (!BAN_APPEAL_OUTCOMES.includes(outcome)) {
    throw new BanServiceError(
      "INVALID_APPEAL_OUTCOME",
      `Invalid ban appeal outcome. Expected one of: ${BAN_APPEAL_OUTCOMES.join(", ")}.`
    );
  }

  const user = await prisma.user.findFirst({
    where: {
      githubUsername: {
        equals: normalizedUsername,
        mode: "insensitive",
      },
    },
  });

  const appealNote: BanAppealNote = {
    id: `${normalizedUsername}:${Date.now()}`,
    githubUsername: normalizedUsername,
    note: trimmedNote,
    outcome,
    actorId,
    actorLogin: actorLogin ?? null,
    createdAt: new Date(),
  };

  await recordAuditLog({
    action: "contributor.ban_appeal_note",
    actorId,
    actorLogin: actorLogin ?? null,
    targetId: user?.id ?? null,
    targetLabel: normalizedUsername,
    metadata: {
      githubUsername: normalizedUsername,
      note: trimmedNote,
      outcome,
    },
  });

  return appealNote;
}
