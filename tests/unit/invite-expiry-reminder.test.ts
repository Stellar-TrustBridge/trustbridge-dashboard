import { describe, it, expect, beforeEach, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { countExpiringInvites, findExpiringInvites } from "@/lib/invite-helpers";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    invite: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

describe("Invite Expiry Reminder Helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findExpiringInvites", () => {
    it("should find invites expiring within threshold", async () => {
      const now = new Date();
      const expiringInvite = {
        id: "invite-1",
        codeHash: "hash1",
        batchLabel: "Wave 1",
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h from now
        used: false,
        usedAt: null,
        createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        generatedById: "user-1",
      };

      vi.mocked(prisma.invite.findMany).mockResolvedValue([expiringInvite]);

      const result = await findExpiringInvites(48 * 60 * 60 * 1000); // 48h threshold

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("invite-1");
      expect(result[0].batchLabel).toBe("Wave 1");
      expect(result[0].used).toBe(false);
    });

    it("should exclude already used invites", async () => {
      const now = new Date();
      const usedInvite = {
        id: "invite-2",
        codeHash: "hash2",
        batchLabel: null,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        used: true,
        usedAt: new Date(),
        createdAt: now,
        generatedById: "user-1",
      };

      vi.mocked(prisma.invite.findMany).mockResolvedValue([]);

      const result = await findExpiringInvites();

      expect(result).toHaveLength(0);
      expect(prisma.invite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            used: false,
            usedAt: null,
          }),
        })
      );
    });

    it("should exclude invites already expired", async () => {
      vi.mocked(prisma.invite.findMany).mockResolvedValue([]);

      await findExpiringInvites();

      expect(prisma.invite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: expect.objectContaining({
              gte: expect.any(Date), // Now
              lte: expect.any(Date), // Threshold
            }),
          }),
        })
      );
    });

    it("should return empty array when no invites expiring", async () => {
      vi.mocked(prisma.invite.findMany).mockResolvedValue([]);

      const result = await findExpiringInvites();

      expect(result).toEqual([]);
    });

    it("should use default 48h threshold", async () => {
      vi.mocked(prisma.invite.findMany).mockResolvedValue([]);

      await findExpiringInvites();

      const call = vi.mocked(prisma.invite.findMany).mock.calls[0][0];
      const where = call?.where as any;
      const gte = where?.expiresAt?.gte as Date;
      const lte = where?.expiresAt?.lte as Date;

      // Should be roughly 48 hours apart
      const diffMs = lte.getTime() - gte.getTime();
      expect(diffMs).toBeGreaterThan(47 * 60 * 60 * 1000);
      expect(diffMs).toBeLessThan(49 * 60 * 60 * 1000);
    });
  });

  describe("countExpiringInvites", () => {
    it("should count invites expiring within threshold", async () => {
      vi.mocked(prisma.invite.count).mockResolvedValue(5);

      const count = await countExpiringInvites();

      expect(count).toBe(5);
    });

    it("should return 0 when no invites expiring", async () => {
      vi.mocked(prisma.invite.count).mockResolvedValue(0);

      const count = await countExpiringInvites();

      expect(count).toBe(0);
    });

    it("should use custom threshold", async () => {
      vi.mocked(prisma.invite.count).mockResolvedValue(3);

      await countExpiringInvites(72 * 60 * 60 * 1000); // 72h

      expect(prisma.invite.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        })
      );
    });
  });
});
