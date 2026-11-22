import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  getNotificationsForUser,
  markNotificationsAsRead,
} from "@/lib/notifications";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/notification-preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safe defaults seeded for new users so Wave contributors are not flooded
 * with mail. Digest is weekly (opt-in to more), disputes stay on because
 * they are actionable and time-sensitive.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  digest: true,
  dispute: true,
} as const;

const markReadSchema = z.object({
  notificationIds: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

const preferencesSchema = z
  .object({
    digest: z.boolean().optional(),
    dispute: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.digest !== undefined || value.dispute !== undefined, {
    message: "At least one preference (digest or dispute) must be provided",
  });

/**
 * GET /api/notifications
 * Returns notifications and unread count for the authenticated user.
 * With `?scope=preferences`, returns that user's mail preferences instead.
 * New users without stored preferences receive the safe defaults.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  if (request.nextUrl.searchParams.get("scope") === "preferences") {
    const stored = await getNotificationPreferences(userId);
    const preferences = stored ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return NextResponse.json(
      { preferences },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const isMaintainer = Boolean(session.user.isMaintainer);
  const maintainerOrgId = session.user.maintainerOrgId ?? "default";

  const { notifications, unreadCount } = await getNotificationsForUser(
    userId,
    isMaintainer,
    { limit: 30, maintainerOrgId }
  );

  return NextResponse.json(
    { notifications, unreadCount },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * PATCH /api/notifications
 * Marks specific notification IDs or all notifications as read.
 * With `?scope=preferences`, updates digest/dispute mail preferences instead.
 */
export async function PATCH(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body marks all as read
  }

  if (request.nextUrl.searchParams.get("scope") === "preferences") {
    const parsedPreferences = preferencesSchema.safeParse(body);
    if (!parsedPreferences.success) {
      return NextResponse.json(
        { error: "Invalid preferences", details: parsedPreferences.error.flatten() },
        { status: 400 }
      );
    }

    const preferences = await updateNotificationPreferences(
      session.user.id,
      parsedPreferences.data
    );
    return NextResponse.json(
      { success: true, preferences },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const parsed = markReadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const userId = session.user.id;
  const isMaintainer = Boolean(session.user.isMaintainer);
  const maintainerOrgId = session.user.maintainerOrgId ?? "default";

  const { notificationIds, all } = parsed.data;

  const { unreadCount } = await markNotificationsAsRead(
    userId,
    isMaintainer,
    all ? undefined : notificationIds,
    maintainerOrgId
  );

  return NextResponse.json(
    { success: true, unreadCount },
    { headers: { "Cache-Control": "no-store" } }
  );
}
