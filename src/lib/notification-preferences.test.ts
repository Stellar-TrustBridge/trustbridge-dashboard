/**
 * Tests for notification preference storage, parsing, and edge toggles.
 *
 * Covers:
 *  - parseNotificationPreferences: defaults, explicit values, mirror-key
 *    fallback, and all digest/dispute/nudge toggle combinations.
 *  - withNotificationPreferences: round-trip fidelity and checklist key
 *    preservation.
 *  - getNotificationPreferences / updateNotificationPreferences: DB happy
 *    path and two distinct failure paths (user not found, DB error).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  parseNotificationPreferences,
  withNotificationPreferences,
  getNotificationPreferences,
  updateNotificationPreferences,
} from "./notification-preferences";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a raw `checklistCompleted` JSON value with the preference block. */
function rawWith(prefs: { digest?: boolean; dispute?: boolean }): object {
  return {
    profileComplete: true,
    [NOTIFICATION_PREFERENCES_KEY]: prefs,
    [`${NOTIFICATION_PREFERENCES_KEY}.digest`]: prefs.digest,
    [`${NOTIFICATION_PREFERENCES_KEY}.dispute`]: prefs.dispute,
  };
}

// ─── parseNotificationPreferences ─────────────────────────────────────────

describe("parseNotificationPreferences", () => {
  it("returns defaults when raw value is null", () => {
    expect(parseNotificationPreferences(null)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES
    );
  });

  it("returns defaults when raw value is undefined", () => {
    expect(parseNotificationPreferences(undefined)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES
    );
  });

  it("returns defaults when raw value is an empty object", () => {
    expect(parseNotificationPreferences({})).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES
    );
  });

  it("returns defaults when raw value is not an object (string)", () => {
    expect(parseNotificationPreferences("not-an-object")).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES
    );
  });

  it("reads explicit true for both categories", () => {
    const raw = rawWith({ digest: true, dispute: true });
    expect(parseNotificationPreferences(raw)).toEqual({
      digest: true,
      dispute: true,
    });
  });

  it("reads explicit false for both categories", () => {
    const raw = rawWith({ digest: false, dispute: false });
    expect(parseNotificationPreferences(raw)).toEqual({
      digest: false,
      dispute: false,
    });
  });

  it("reads digest=false, dispute=true independently", () => {
    const raw = rawWith({ digest: false, dispute: true });
    expect(parseNotificationPreferences(raw)).toEqual({
      digest: false,
      dispute: true,
    });
  });

  it("reads digest=true, dispute=false independently", () => {
    const raw = rawWith({ digest: true, dispute: false });
    expect(parseNotificationPreferences(raw)).toEqual({
      digest: true,
      dispute: false,
    });
  });

  it("falls back to mirror key when nested object is absent but mirrors exist", () => {
    // Simulate a checklist rewrite that removed the nested object but kept mirrors.
    const raw = {
      profileComplete: true,
      [`${NOTIFICATION_PREFERENCES_KEY}.digest`]: false,
      [`${NOTIFICATION_PREFERENCES_KEY}.dispute`]: true,
    };
    const result = parseNotificationPreferences(raw);
    expect(result.digest).toBe(false);
    expect(result.dispute).toBe(true);
  });

  it("nested value wins over mirror key when both present", () => {
    // Nested says false, mirror says true — nested takes priority.
    const raw = {
      [NOTIFICATION_PREFERENCES_KEY]: { digest: false, dispute: false },
      [`${NOTIFICATION_PREFERENCES_KEY}.digest`]: true,
      [`${NOTIFICATION_PREFERENCES_KEY}.dispute`]: true,
    };
    const result = parseNotificationPreferences(raw);
    expect(result.digest).toBe(false);
    expect(result.dispute).toBe(false);
  });

  it("ignores non-boolean values in the nested object (falls back to default)", () => {
    const raw = {
      [NOTIFICATION_PREFERENCES_KEY]: { digest: "yes", dispute: 1 },
    };
    const result = parseNotificationPreferences(raw);
    // Neither value is boolean → falls back to mirrors (absent) → defaults.
    expect(result.digest).toBe(DEFAULT_NOTIFICATION_PREFERENCES.digest);
    expect(result.dispute).toBe(DEFAULT_NOTIFICATION_PREFERENCES.dispute);
  });

  // ── Digest / dispute / nudge combination matrix ──────────────────────────
  // These ensure every combination of two binary preferences round-trips
  // correctly so a mail-storm cannot be introduced by a partial parse.

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("combination digest=%s dispute=%s round-trips cleanly", (digest, dispute) => {
    const raw = rawWith({ digest, dispute });
    expect(parseNotificationPreferences(raw)).toEqual({ digest, dispute });
  });
});

// ─── withNotificationPreferences ──────────────────────────────────────────

describe("withNotificationPreferences", () => {
  it("writes both nested object and mirror keys", () => {
    const result = withNotificationPreferences({}, { digest: false, dispute: true }) as Record<string, unknown>;
    expect(result[NOTIFICATION_PREFERENCES_KEY]).toEqual({ digest: false, dispute: true });
    expect(result[`${NOTIFICATION_PREFERENCES_KEY}.digest`]).toBe(false);
    expect(result[`${NOTIFICATION_PREFERENCES_KEY}.dispute`]).toBe(true);
  });

  it("preserves unrelated checklist keys", () => {
    const existing = { profileComplete: true, someOtherKey: "value" };
    const result = withNotificationPreferences(existing, { digest: true, dispute: false }) as Record<string, unknown>;
    expect(result.profileComplete).toBe(true);
    expect(result.someOtherKey).toBe("value");
  });

  it("overwrites stale mirror keys on update", () => {
    // Previously digest was true, now it is false.
    const existing = {
      [NOTIFICATION_PREFERENCES_KEY]: { digest: true, dispute: true },
      [`${NOTIFICATION_PREFERENCES_KEY}.digest`]: true,
      [`${NOTIFICATION_PREFERENCES_KEY}.dispute`]: true,
    };
    const result = withNotificationPreferences(existing, { digest: false, dispute: true }) as Record<string, unknown>;
    expect(result[`${NOTIFICATION_PREFERENCES_KEY}.digest`]).toBe(false);
  });

  it("produces a value that round-trips through parseNotificationPreferences", () => {
    const prefs = { digest: false, dispute: true };
    const written = withNotificationPreferences({ profileComplete: true }, prefs);
    expect(parseNotificationPreferences(written)).toEqual(prefs);
  });
});

// ─── getNotificationPreferences ───────────────────────────────────────────

describe("getNotificationPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path — returns persisted preferences", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: rawWith({ digest: false, dispute: true }),
    } as any);

    const result = await getNotificationPreferences("user-1");
    expect(result).toEqual({ digest: false, dispute: true });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { checklistCompleted: true },
    });
  });

  it("failure path — user not found returns defaults", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    const result = await getNotificationPreferences("ghost-user");
    expect(result).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("failure path — DB error propagates as a thrown error", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("connection reset")
    );

    await expect(getNotificationPreferences("user-db-error")).rejects.toThrow(
      "connection reset"
    );
  });
});

// ─── updateNotificationPreferences ────────────────────────────────────────

describe("updateNotificationPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path — partial update preserves unchanged preference", async () => {
    // User currently has digest=true, dispute=true.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: rawWith({ digest: true, dispute: true }),
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    // Only flip digest to false.
    const result = await updateNotificationPreferences("user-1", { digest: false });

    expect(result).toEqual({ digest: false, dispute: true });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
      })
    );
  });

  it("happy path — both categories can be toggled simultaneously", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: rawWith({ digest: true, dispute: true }),
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    const result = await updateNotificationPreferences("user-2", {
      digest: false,
      dispute: false,
    });
    expect(result).toEqual({ digest: false, dispute: false });
  });

  it("failure path — user not found (findUnique returns null) merges with defaults", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

    // Defaults are both true; updating dispute=false should produce {digest:true, dispute:false}.
    const result = await updateNotificationPreferences("ghost", { dispute: false });
    expect(result).toEqual({ digest: true, dispute: false });
  });

  it("failure path — DB write error propagates", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: rawWith({ digest: true, dispute: true }),
    } as any);
    vi.mocked(prisma.user.update).mockRejectedValueOnce(
      new Error("deadlock detected")
    );

    await expect(
      updateNotificationPreferences("user-write-fail", { digest: false })
    ).rejects.toThrow("deadlock detected");
  });

  it("idempotent — applying the same value twice leaves preferences unchanged", async () => {
    const stored = rawWith({ digest: false, dispute: true });

    // First call
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: stored,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    const first = await updateNotificationPreferences("user-idempotent", {
      digest: false,
    });

    // Second call with same value
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      checklistCompleted: stored,
    } as any);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);
    const second = await updateNotificationPreferences("user-idempotent", {
      digest: false,
    });

    expect(first).toEqual(second);
  });

  // ── Nudge-combination matrix ───────────────────────────────────────────
  // Verifies that toggling digest does not accidentally change dispute,
  // and vice versa — the two categories are independent.

  it.each([
    // [initialDigest, initialDispute, updateDigest, expectedDispute]
    [true, true, false, true],
    [true, false, false, false],
    [false, true, true, true],
    [false, false, true, false],
  ])(
    "toggling digest only: initial {digest:%s,dispute:%s} → update digest=%s keeps dispute=%s",
    async (initDigest, initDispute, newDigest, expectedDispute) => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        checklistCompleted: rawWith({ digest: initDigest, dispute: initDispute }),
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

      const result = await updateNotificationPreferences("user-matrix", {
        digest: newDigest,
      });
      expect(result.digest).toBe(newDigest);
      expect(result.dispute).toBe(expectedDispute);
    }
  );

  it.each([
    // [initialDigest, initialDispute, updateDispute, expectedDigest]
    [true, true, false, true],
    [false, true, false, false],
    [true, false, true, true],
    [false, false, true, false],
  ])(
    "toggling dispute only: initial {digest:%s,dispute:%s} → update dispute=%s keeps digest=%s",
    async (initDigest, initDispute, newDispute, expectedDigest) => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        checklistCompleted: rawWith({ digest: initDigest, dispute: initDispute }),
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValueOnce({} as any);

      const result = await updateNotificationPreferences("user-matrix-2", {
        dispute: newDispute,
      });
      expect(result.dispute).toBe(newDispute);
      expect(result.digest).toBe(expectedDigest);
    }
  );
});
