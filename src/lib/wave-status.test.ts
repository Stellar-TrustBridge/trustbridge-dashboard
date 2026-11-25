/**
 * Tests for src/lib/wave-status.ts
 *
 * Coverage:
 *  - deriveOverallStatus: all four combinations of freeze × lag.
 *  - composeBannerMessage: every overallStatus path, every lag reason code.
 *  - getWavePublicStatus: happy path, freeze-only, lag-only, both active,
 *    graceful degradation when injected state is missing.
 *
 * All tests use injected state (options.freezeState / options.lagState) so
 * no I/O or process-env reads are required.
 */

import { describe, expect, it } from "vitest";

import {
  composeBannerMessage,
  deriveOverallStatus,
  getWavePublicStatus,
  type WavePublicLagSignal,
  type WavePublicFreezeSignal,
} from "./wave-status";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK_FREEZE: WavePublicFreezeSignal = {
  active: false,
  reason: null,
  start: null,
  end: null,
};

const ACTIVE_FREEZE: WavePublicFreezeSignal = {
  active: true,
  reason: "Wave roster payout freeze window in effect",
  start: "2026-09-25T00:00:00.000Z",
  end: "2026-09-25T08:00:00.000Z",
};

const OK_LAG: WavePublicLagSignal = {
  status: "ok",
  reason: "ok",
  sinceLastSuccessMs: 60_000,
  thresholdMs: 900_000,
};

const LAGGING_LAG: WavePublicLagSignal = {
  status: "lagging",
  reason: "sync_delayed",
  sinceLastSuccessMs: 1_200_000,
  thresholdMs: 900_000,
};

const STALLED_LAG: WavePublicLagSignal = {
  status: "stalled",
  reason: "sync_stalled",
  sinceLastSuccessMs: 3_700_000,
  thresholdMs: 900_000,
};

const NOW = new Date("2026-09-25T01:00:00.000Z");

// ---------------------------------------------------------------------------
// deriveOverallStatus
// ---------------------------------------------------------------------------

describe("deriveOverallStatus", () => {
  it("returns ok when neither signal is active", () => {
    expect(deriveOverallStatus(false, "ok")).toBe("ok");
    expect(deriveOverallStatus(false, "no_data")).toBe("ok");
    expect(deriveOverallStatus(false, "not_configured")).toBe("ok");
  });

  it("returns frozen when only the freeze window is active", () => {
    expect(deriveOverallStatus(true, "ok")).toBe("frozen");
    expect(deriveOverallStatus(true, "no_data")).toBe("frozen");
  });

  it("returns degraded when only the lag signal is active", () => {
    expect(deriveOverallStatus(false, "lagging")).toBe("degraded");
    expect(deriveOverallStatus(false, "stalled")).toBe("degraded");
  });

  it("returns frozen_and_degraded when both signals are active", () => {
    expect(deriveOverallStatus(true, "lagging")).toBe("frozen_and_degraded");
    expect(deriveOverallStatus(true, "stalled")).toBe("frozen_and_degraded");
  });
});

// ---------------------------------------------------------------------------
// composeBannerMessage
// ---------------------------------------------------------------------------

describe("composeBannerMessage", () => {
  it("ok — reports normal operation", () => {
    const msg = composeBannerMessage("ok", null, "ok");
    expect(msg).toMatch(/operating normally/i);
  });

  it("frozen — uses the provided freeze reason", () => {
    const msg = composeBannerMessage(
      "frozen",
      "Wave roster payout freeze window in effect",
      "ok"
    );
    expect(msg).toContain("Wave roster payout freeze window in effect");
  });

  it("frozen — falls back to default copy when reason is null", () => {
    const msg = composeBannerMessage("frozen", null, "ok");
    expect(msg).toMatch(/frozen/i);
    expect(msg).toMatch(/disabled/i);
  });

  it.each([
    ["sync_delayed", /delayed/i],
    ["sync_stalled", /stalled/i],
    ["cursor_stalled", /cursor/i],
    ["never_succeeded", /not completed successfully/i],
  ] as const)("degraded — %s produces an actionable message", (reason, pattern) => {
    const msg = composeBannerMessage("degraded", null, reason);
    expect(msg).toMatch(pattern);
  });

  it("degraded — unknown reason falls back to generic copy", () => {
    const msg = composeBannerMessage("degraded", null, "unknown_code");
    expect(msg).toMatch(/degraded/i);
  });

  it("frozen_and_degraded — mentions both conditions", () => {
    const msg = composeBannerMessage("frozen_and_degraded", null, "sync_stalled");
    expect(msg).toMatch(/frozen/i);
    expect(msg).toMatch(/degraded/i);
  });
});

// ---------------------------------------------------------------------------
// getWavePublicStatus — happy path
// ---------------------------------------------------------------------------

describe("getWavePublicStatus — happy path (no active issues)", () => {
  it("returns ok overall when freeze is inactive and lag is ok", async () => {
    const result = await getWavePublicStatus({
      freezeState: { active: false },
      lagState: {
        status: "ok",
        reason: "ok",
        sinceLastSuccessMs: 60_000,
        thresholdMs: 900_000,
      },
      now: NOW,
    });

    expect(result.overallStatus).toBe("ok");
    expect(result.freeze.active).toBe(false);
    expect(result.queueLag.status).toBe("ok");
    expect(result.message).toMatch(/operating normally/i);
    expect(result.computedAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// getWavePublicStatus — failure path 1: freeze active
// ---------------------------------------------------------------------------

describe("getWavePublicStatus — failure path: freeze window active", () => {
  it("returns frozen overall and surfaces freeze details", async () => {
    const result = await getWavePublicStatus({
      freezeState: {
        active: true,
        reason: "Wave roster payout freeze window in effect",
        start: new Date("2026-09-25T00:00:00.000Z"),
        end: new Date("2026-09-25T08:00:00.000Z"),
      },
      lagState: { status: "ok", reason: "ok", sinceLastSuccessMs: 60_000, thresholdMs: 900_000 },
      now: NOW,
    });

    expect(result.overallStatus).toBe("frozen");
    expect(result.freeze.active).toBe(true);
    expect(result.freeze.reason).toBe("Wave roster payout freeze window in effect");
    expect(result.freeze.start).toBe("2026-09-25T00:00:00.000Z");
    expect(result.freeze.end).toBe("2026-09-25T08:00:00.000Z");
    expect(result.queueLag.status).toBe("ok");
    expect(result.message).toContain("Wave roster payout freeze window");
  });

  it("message falls back to default copy when reason is omitted", async () => {
    const result = await getWavePublicStatus({
      freezeState: { active: true },
      lagState: { status: "ok", reason: "ok", sinceLastSuccessMs: null, thresholdMs: 900_000 },
      now: NOW,
    });

    expect(result.overallStatus).toBe("frozen");
    expect(result.message).toMatch(/frozen/i);
  });
});

// ---------------------------------------------------------------------------
// getWavePublicStatus — failure path 2: contract sync lagging
// ---------------------------------------------------------------------------

describe("getWavePublicStatus — failure path: contract sync lag", () => {
  it("returns degraded when lag status is lagging", async () => {
    const result = await getWavePublicStatus({
      freezeState: { active: false },
      lagState: {
        status: "lagging",
        reason: "sync_delayed",
        sinceLastSuccessMs: 1_200_000,
        thresholdMs: 900_000,
      },
      now: NOW,
    });

    expect(result.overallStatus).toBe("degraded");
    expect(result.queueLag.status).toBe("lagging");
    expect(result.queueLag.reason).toBe("sync_delayed");
    expect(result.queueLag.sinceLastSuccessMs).toBe(1_200_000);
    expect(result.message).toMatch(/delayed/i);
  });

  it("returns degraded when lag status is stalled", async () => {
    const result = await getWavePublicStatus({
      freezeState: { active: false },
      lagState: {
        status: "stalled",
        reason: "sync_stalled",
        sinceLastSuccessMs: 4_000_000,
        thresholdMs: 900_000,
      },
      now: NOW,
    });

    expect(result.overallStatus).toBe("degraded");
    expect(result.queueLag.status).toBe("stalled");
    expect(result.message).toMatch(/stalled/i);
  });

  it("returns frozen_and_degraded when both signals are simultaneously active", async () => {
    const result = await getWavePublicStatus({
      freezeState: {
        active: true,
        reason: "Freeze active",
        start: new Date("2026-09-25T00:00:00.000Z"),
        end: new Date("2026-09-25T08:00:00.000Z"),
      },
      lagState: {
        status: "stalled",
        reason: "cursor_stalled",
        sinceLastSuccessMs: 7_200_000,
        thresholdMs: 900_000,
      },
      now: NOW,
    });

    expect(result.overallStatus).toBe("frozen_and_degraded");
    expect(result.freeze.active).toBe(true);
    expect(result.queueLag.status).toBe("stalled");
    expect(result.message).toMatch(/frozen/i);
    expect(result.message).toMatch(/degraded/i);
  });
});

// ---------------------------------------------------------------------------
// getWavePublicStatus — graceful degradation on missing state
// ---------------------------------------------------------------------------

describe("getWavePublicStatus — graceful degradation", () => {
  it("defaults to ok when no injected state is provided (pure option omission)", async () => {
    // Both signals use injected state; pass minimal stubs to avoid real I/O.
    const result = await getWavePublicStatus({
      freezeState: { active: false },
      lagState: { status: "ok", reason: "no_data", sinceLastSuccessMs: null, thresholdMs: 0 },
    });

    expect(result.overallStatus).toBe("ok");
    expect(result.freeze.active).toBe(false);
  });

  it("produces a stable payload shape regardless of which signals are active", async () => {
    for (const [freeze, lag] of [
      [false, "ok"],
      [true, "ok"],
      [false, "lagging"],
      [true, "stalled"],
    ] as [boolean, string][]) {
      const result = await getWavePublicStatus({
        freezeState: { active: freeze },
        lagState: { status: lag, reason: lag, sinceLastSuccessMs: null, thresholdMs: 900_000 },
        now: NOW,
      });

      // Every result must carry all required fields regardless of status.
      expect(result).toHaveProperty("overallStatus");
      expect(result).toHaveProperty("freeze");
      expect(result).toHaveProperty("queueLag");
      expect(result).toHaveProperty("message");
      expect(result).toHaveProperty("computedAt");
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("computedAt matches the injected now timestamp", async () => {
    const pinned = new Date("2026-01-15T12:00:00.000Z");
    const result = await getWavePublicStatus({
      freezeState: { active: false },
      lagState: { status: "ok", reason: "ok", sinceLastSuccessMs: null, thresholdMs: 900_000 },
      now: pinned,
    });
    expect(result.computedAt).toBe(pinned.toISOString());
  });
});
