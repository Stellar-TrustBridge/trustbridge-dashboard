import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNotification,
  getNotificationsForUser,
  markNotificationsAsRead,
  sanitizeNotificationPii,
  truncateNotificationText,
} from "./notifications";

// Mock Prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";

describe("notifications library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sanitizeNotificationPii", () => {
    it("redacts email addresses", () => {
      const input = "User alice@example.com submitted a request for bob.smith@domain.co.uk";
      const sanitized = sanitizeNotificationPii(input);
      expect(sanitized).toBe(
        "User [redacted-email] submitted a request for [redacted-email]"
      );
    });

    it("redacts Stellar G-addresses", () => {
      const address = "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";
      const input = `Wallet ${address} was checked`;
      const sanitized = sanitizeNotificationPii(input);
      expect(sanitized).toBe("Wallet [redacted-address] was checked");
    });
  });

  describe("truncateNotificationText", () => {
    it("returns unchanged text if under maxLength", () => {
      expect(truncateNotificationText("Short text", 20)).toBe("Short text");
    });

    it("truncates and appends ellipsis if over maxLength", () => {
      const text = "A".repeat(150);
      const truncated = truncateNotificationText(text, 100);
      expect(truncated.length).toBe(100);
      expect(truncated.endsWith("...")).toBe(true);
    });
  });

  describe("createNotification", () => {
    it("sanitizes and truncates inputs before creating DB record", async () => {
      vi.mocked(prisma.notification.create).mockResolvedValue({} as any);

      await createNotification({
        userId: "user-1",
        type: "BATCH_JOB_COMPLETED",
        title: `Batch check for alice@example.com finished ${"!".repeat(100)}`,
        body: `Details for GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS`,
      });

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          maintainerOrgId: "default",
          type: "BATCH_JOB_COMPLETED",
          title: expect.not.stringContaining("alice@example.com"),
          body: expect.not.stringContaining("GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS"),
        }),
      });
    });
  });

  describe("getNotificationsForUser", () => {
    it("fetches user-only notifications for non-maintainers", async () => {
      vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.notification.count).mockResolvedValue(0);

      await getNotificationsForUser("user-1", false);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-1",
            maintainerOrgId: "default",
          }),
        })
      );
    });

    it("includes broadcast notifications (userId null) for maintainers", async () => {
      vi.mocked(prisma.notification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.notification.count).mockResolvedValue(0);

      await getNotificationsForUser("maintainer-1", true);

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ userId: "maintainer-1" }, { userId: null }],
            maintainerOrgId: "default",
          }),
        })
      );
    });
  });

  describe("markNotificationsAsRead (IDOR Protection)", () => {
    it("restricts updates to the authenticated user's notifications", async () => {
      vi.mocked(prisma.notification.updateMany).mockResolvedValue({ count: 1 });
      vi.mocked(prisma.notification.count).mockResolvedValue(0);

      await markNotificationsAsRead("user-1", false, ["notif-1"]);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId: "user-1",
          id: { in: ["notif-1"] },
          read: false,
        }),
        data: expect.objectContaining({
          read: true,
        }),
      });
    });
  });
});

// ─── Digest / dispute / nudge preference combinations ─────────────────────
//
// These tests live here (notifications.test.ts) rather than in a separate
// file so the issue requirement "update src/lib/notifications.test.ts" is met
// while the notification preferences module keeps its own deeper unit tests in
// notification-preferences.test.ts.

import {
  parseNotificationPreferences,
  updateNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from "./notification-preferences";

describe("Notification preference edge toggles (digest / dispute / nudge)", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── parseNotificationPreferences defaults ──────────────────────────────

  it("defaults both digest and dispute to true when preferences are absent", () => {
    expect(parseNotificationPreferences(null)).toEqual({
      digest: true,
      dispute: true,
    });
  });

  it("defaults both to true when stored value is an empty object", () => {
    expect(parseNotificationPreferences({})).toEqual({
      digest: true,
      dispute: true,
    });
  });

  it("digest=false does not affect dispute default", () => {
    const raw = {
      __notificationPreferences: { digest: false },
      "__notificationPreferences.digest": false,
    };
    const result = parseNotificationPreferences(raw);
    expect(result.digest).toBe(false);
    expect(result.dispute).toBe(DEFAULT_NOTIFICATION_PREFERENCES.dispute); // true
  });

  it("dispute=false does not affect digest default", () => {
    const raw = {
      __notificationPreferences: { dispute: false },
      "__notificationPreferences.dispute": false,
    };
    const result = parseNotificationPreferences(raw);
    expect(result.dispute).toBe(false);
    expect(result.digest).toBe(DEFAULT_NOTIFICATION_PREFERENCES.digest); // true
  });

  // ── updateNotificationPreferences partial updates ─────────────────────

  it("toggling digest off preserves the dispute preference", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: {
        __notificationPreferences: { digest: true, dispute: false },
        "__notificationPreferences.digest": true,
        "__notificationPreferences.dispute": false,
      },
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await updateNotificationPreferences("u1", { digest: false });

    expect(result).toEqual({ digest: false, dispute: false });
  });

  it("toggling dispute on preserves the digest preference", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: {
        __notificationPreferences: { digest: false, dispute: false },
        "__notificationPreferences.digest": false,
        "__notificationPreferences.dispute": false,
      },
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await updateNotificationPreferences("u2", { dispute: true });

    expect(result).toEqual({ digest: false, dispute: true });
  });

  it("toggling both off at once produces {digest:false, dispute:false}", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: {
        __notificationPreferences: { digest: true, dispute: true },
        "__notificationPreferences.digest": true,
        "__notificationPreferences.dispute": true,
      },
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await updateNotificationPreferences("u3", {
      digest: false,
      dispute: false,
    });

    expect(result).toEqual({ digest: false, dispute: false });
  });

  // ── Failure paths ──────────────────────────────────────────────────────

  it("DB error on findUnique propagates rather than silently succeeding", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("DB timeout")
    );

    await expect(
      updateNotificationPreferences("u-fail", { digest: false })
    ).rejects.toThrow("DB timeout");
  });

  it("DB error on update propagates rather than silently succeeding", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: {
        __notificationPreferences: { digest: true, dispute: true },
      },
    } as any);
    vi.mocked(prisma.user.update).mockRejectedValueOnce(
      new Error("unique constraint violated")
    );

    await expect(
      updateNotificationPreferences("u-write-fail", { digest: false })
    ).rejects.toThrow("unique constraint violated");
  });
});
