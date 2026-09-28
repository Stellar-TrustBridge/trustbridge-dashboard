import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { isFreezeWindowActive, enforceFreezeWindowGuard } from "./freeze-window";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(true),
}));

describe("Wave Freeze Window", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: false when FREEZE_WINDOW_ENABLED is false", () => {
    process.env.FREEZE_WINDOW_ENABLED = "false";
    process.env.FREEZE_WINDOW_START = "2026-08-30T00:00:00Z";
    process.env.FREEZE_WINDOW_END = "2026-09-02T00:00:00Z";

    const status = isFreezeWindowActive(new Date("2026-08-31T12:00:00Z"));
    expect(status.active).toBe(false);
  });

  it("returns active: false when dates are missing", () => {
    delete process.env.FREEZE_WINDOW_START;
    delete process.env.FREEZE_WINDOW_END;

    const status = isFreezeWindowActive(new Date());
    expect(status.active).toBe(false);
  });

  it("returns active: true when current date is inside freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = "2026-08-30T00:00:00Z";
    process.env.FREEZE_WINDOW_END = "2026-09-02T00:00:00Z";

    const status = isFreezeWindowActive(new Date("2026-08-31T12:00:00Z"));
    expect(status.active).toBe(true);
    expect(status.reason).toContain("freeze window");
  });

  it("returns active: false when current date is outside freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = "2026-08-30T00:00:00Z";
    process.env.FREEZE_WINDOW_END = "2026-09-02T00:00:00Z";

    const status = isFreezeWindowActive(new Date("2026-09-05T12:00:00Z"));
    expect(status.active).toBe(false);
  });

  it("blocks non-maintainer requests during active freeze window with 423 Locked", async () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = "2026-08-30T00:00:00Z";
    process.env.FREEZE_WINDOW_END = "2026-09-02T00:00:00Z";

    const req = new NextRequest("http://localhost:3000/api/register/recheck", {
      method: "POST",
    });

    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-123",
      userLogin: "contributor1",
    });

    expect(guard.blocked).toBe(true);
    expect(guard.response?.status).toBe(423);

    const json = await guard.response?.json();
    expect(json.code).toBe("WAVE_FREEZE_ACTIVE");
    expect(json.error).toContain("frozen for wave payout");
  });

  it("allows maintainer requests with x-freeze-override header", async () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = "2026-08-30T00:00:00Z";
    process.env.FREEZE_WINDOW_END = "2026-09-02T00:00:00Z";

    const req = new NextRequest("http://localhost:3000/api/register/recheck", {
      method: "POST",
      headers: { "x-freeze-override": "true" },
    });

    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-1",
      userLogin: "admin_user",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(true);
  });
});
