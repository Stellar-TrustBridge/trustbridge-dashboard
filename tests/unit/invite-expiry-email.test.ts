import { describe, it, expect } from "vitest";

import { buildInviteExpiryReminderBody } from "@/lib/email";

describe("Invite Expiry Reminder Email", () => {
  it("should build email body with expiring invites", () => {
    const now = new Date();
    const details = {
      expiringCount: 3,
      thresholdHours: 48,
      invites: [
        {
          batchLabel: "Wave 1",
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        },
        {
          batchLabel: null,
          expiresAt: new Date(now.getTime() + 36 * 60 * 60 * 1000),
          createdAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
        },
        {
          batchLabel: "Wave 2",
          expiresAt: new Date(now.getTime() + 40 * 60 * 60 * 1000),
          createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
        },
      ],
      generatedAt: "2026-10-19T10:00:00Z",
    };

    const body = buildInviteExpiryReminderBody(details);

    expect(body).toContain("Invite Expiry Reminder");
    expect(body).toContain("3 invites will expire within the next 48 hours");
    expect(body).toContain("⚠️ Action required");
    expect(body).toContain("Wave 1");
    expect(body).toContain("Wave 2");
    expect(body).toContain("(no label)");
    expect(body).toContain("Manage invites →");
  });

  it("should use singular form for single invite", () => {
    const now = new Date();
    const details = {
      expiringCount: 1,
      thresholdHours: 24,
      invites: [
        {
          batchLabel: "Test Batch",
          expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
          createdAt: now,
        },
      ],
    };

    const body = buildInviteExpiryReminderBody(details);

    expect(body).toContain("1 invite will expire within the next 24 hour");
    expect(body).not.toContain("invites");
  });

  it("should truncate long invite lists to first 10", () => {
    const now = new Date();
    const invites = Array.from({ length: 15 }, (_, i) => ({
      batchLabel: `Batch ${i + 1}`,
      expiresAt: new Date(now.getTime() + (i + 1) * 60 * 60 * 1000),
      createdAt: now,
    }));

    const details = {
      expiringCount: 15,
      thresholdHours: 48,
      invites,
    };

    const body = buildInviteExpiryReminderBody(details);

    expect(body).toContain("Batch 1");
    expect(body).toContain("Batch 10");
    expect(body).toContain("… and 5 more");
  });

  it("should handle invites without batch labels", () => {
    const now = new Date();
    const details = {
      expiringCount: 2,
      thresholdHours: 48,
      invites: [
        {
          batchLabel: null,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          createdAt: now,
        },
        {
          batchLabel: null,
          expiresAt: new Date(now.getTime() + 36 * 60 * 60 * 1000),
          createdAt: now,
        },
      ],
    };

    const body = buildInviteExpiryReminderBody(details);

    expect(body).toContain("(no label)");
  });

  it("should include dashboard link", () => {
    const now = new Date();
    const details = {
      expiringCount: 1,
      thresholdHours: 48,
      invites: [
        {
          batchLabel: "Test",
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          createdAt: now,
        },
      ],
    };

    const body = buildInviteExpiryReminderBody(details);

    expect(body).toContain("/dashboard/invites");
    expect(body).toContain('href="');
  });
});
