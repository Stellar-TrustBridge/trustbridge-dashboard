import "server-only";

import { prisma } from "@/lib/prisma";
import type { NotificationType } from "@prisma/client";

export interface CreateNotificationInput {
  userId?: string | null;
  maintainerOrgId?: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/**
 * Digest cadence options for notification email preferences.
 */
export type DigestFrequency = "off" | "daily" | "weekly";

/**
 * Notification email preferences for a user.
 */
export interface NotificationPreferences {
  digestFrequency: DigestFrequency;
  disputesEnabled: boolean;
}

/**
 * Safe defaults seeded for new users.
 * - Weekly digest (not daily) to avoid noisy mail.
 * - Disputes enabled so users are not surprised by missed disputes.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  digestFrequency: "weekly",
  disputesEnabled: true,
});

/**
 * Returns a fresh copy of the default notification preferences for new users.
 */
export function getDefaultNotificationPreferences(): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

/**
 * Normalizes a partial/unknown preference payload into a complete, valid
 * NotificationPreferences object, falling back to safe defaults for any
 * missing or malformed field.
 */
export function normalizeNotificationPreferences(
  input?: Partial<NotificationPreferences> | null
): NotificationPreferences {
  const defaults = getDefaultNotificationPreferences();
  if (!input) return defaults;

  const digestFrequency: DigestFrequency =
    input.digestFrequency === "off" ||
    input.digestFrequency === "daily" ||
    input.digestFrequency === "weekly"
      ? input.digestFrequency
      : defaults.digestFrequency;

  const disputesEnabled =
    typeof input.disputesEnabled === "boolean"
      ? input.disputesEnabled
      : defaults.disputesEnabled;

  return { digestFrequency, disputesEnabled };
}

/**
 * Seeds default notification preferences for a newly created user.
 * Idempotent: repeated calls for the same user return the existing row
 * unchanged rather than overwriting user-chosen settings.
 */
export async function seedDefaultNotificationPreferences(userId: string) {
  if (!userId) {
    throw new Error("seedDefaultNotificationPreferences: userId is required");
  }

  const defaults = getDefaultNotificationPreferences();

  return prisma.notificationPreference.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      digestFrequency: defaults.digestFrequency,
      disputesEnabled: defaults.disputesEnabled,
    },
  });
}

/**
 * Sanitizes PII from notification text:
 * - Replaces email addresses with [redacted-email]
 * - Replaces Stellar G-addresses (G[A-Z0-9]{55}) with [redacted-address]
 */
export function sanitizeNotificationPii(text: string): string {
  if (!text) return "";
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[redacted-email]")
    .replace(/\bG[A-Z0-9]{55}\b/g, "[redacted-address]");
}

/**
 * Truncates text to a maximum length with an ellipsis if truncated.
 */
export function truncateNotificationText(text: string, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Creates a new in-app notification.
 * Automatically caps title to 100 chars, body to 500 chars, and strips PII.
 */
export async function createNotification(input: CreateNotificationInput) {
  const sanitizedTitle = truncateNotificationText(
    sanitizeNotificationPii(input.title),
    100
  );
  const sanitizedBody = truncateNotificationText(
    sanitizeNotificationPii(input.body),
    500
  );

  return prisma.notification.create({
    data: {
      userId: input.userId ?? null,
      maintainerOrgId: input.maintainerOrgId ?? "default",
      type: input.type,
      title: sanitizedTitle,
      body: sanitizedBody,
      metadata: input.metadata ? (input.metadata as never) : undefined,
    },
  });
}

export interface GetNotificationsOptions {
  limit?: number;
  unreadOnly?: boolean;
  maintainerOrgId?: string;
}

/**
 * Fetches notifications accessible to a user.
 * - Non-maintainers receive notifications where userId == current user's ID.
 * - Maintainers receive notifications where userId == current user's ID OR userId IS NULL (org broadcasts).
 * - Filters by maintainerOrgId to prevent cross-tenant leak.
 */
export async function getNotificationsForUser(
  userId: string,
  isMaintainer: boolean,
  options: GetNotificationsOptions = {}
) {
  const { limit = 20, unreadOnly = false, maintainerOrgId = "default" } = options;

  const whereCondition = {
    maintainerOrgId,
    ...(unreadOnly ? { read: false } : {}),
    ...(isMaintainer
      ? { OR: [{ userId }, { userId: null }] }
      : { userId }),
  };

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: whereCondition,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({
      where: {
        maintainerOrgId,
        read: false,
        ...(isMaintainer
          ? { OR: [{ userId }, { userId: null }] }
          : { userId }),
      },
    }),
  ]);

  return { notifications, unreadCount };
}

/**
 * Marks specified notification IDs as read for a given user.
 * Enforces recipient ownership / maintainer authorization to prevent IDOR.
 */
export async function markNotificationsAsRead(
  userId: string,
  isMaintainer: boolean,
  notificationIds?: string[],
  maintainerOrgId = "default"
) {
  const whereCondition = {
    maintainerOrgId,
    read: false,
    ...(notificationIds && notificationIds.length > 0
      ? { id: { in: notificationIds } }
      : {}),
    ...(isMaintainer
      ? { OR: [{ userId }, { userId: null }] }
      : { userId }),
  };

  await prisma.notification.updateMany({
    where: whereCondition,
    data: {
      read: true,
      readAt: new Date(),
    },
  });

  // Return new unread count
  const unreadCount = await prisma.notification.count({
    where: {
      maintainerOrgId,
      read: false,
      ...(isMaintainer
        ? { OR: [{ userId }, { userId: null }] }
        : { userId }),
    },
  });

  return { unreadCount };
}
