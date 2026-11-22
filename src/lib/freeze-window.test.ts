import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  isFreezeWindowActive,
  enforceFreezeWindowGuard,
  mergeFreezeWindows,
} from "./freeze-window";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(true),
}));

// By default the freeze_window feature flag is enabled. Individual tests may
// override FEATURE_FLAG_FREEZE_WINDOW via process.env to flip it.
vi.mock("@/lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn().mockImplementation(async (key: string) => {
    if (key === "freeze_window") {
      const override = process.env.FEATURE_FLAG_FREEZE_WINDOW?.toLowerCase();
      if (override === "false" || override === "0" || override === "off")
        return false;
      return true;
    }
    return false;
  }),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Helpers for building deterministic frozen windows relative to *now* (not
 * hardcoded dates, which rot as soon as the suite runs past them). */
const DAY_MS = 86_400_000;
const PAST_START = new Date(Date.now() - 2 * DAY_MS).toISOString();
const PAST_END = new Date(Date.now() + 2 * DAY_MS).toISOString();
const INSIDE_WINDOW = new Date(Date.now()); // middle of window
const BEFORE_WINDOW = new Date(Date.now() - 3 * DAY_MS); // well before start
const AFTER_WINDOW = new Date(Date.now() + 3 * DAY_MS); // well after end

function makeRequest(
  url = "http://localhost:3000/api/register/recheck",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { method: "POST", headers });
}

// ---------------------------------------------------------------------------
// mergeFreezeWindows — overlapping window merge policy
// ---------------------------------------------------------------------------

describe("mergeFreezeWindows — merge policy", () => {
  it("passes non-overlapping windows through unchanged (happy path)", () => {
    const result = mergeFreezeWindows([
      { start: "2024-01-01T00:00:00.000Z", end: "2024-01-02T00:00:00.000Z" },
      { start: "2024-01-05T00:00:00.000Z", end: "2024-01-06T00:00:00.000Z" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0].start.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z"
    );
    expect(result.windows[1].end.toISOString()).toBe(
      "2024-01-06T00:00:00.000Z"
    );
  });

  it("merges overlapping windows into a single canonical union", () => {
    const result = mergeFreezeWindows([
      { start: "2024-01-01T00:00:00.000Z", end: "2024-01-05T00:00:00.000Z" },
      { start: "2024-01-03T00:00:00.000Z", end: "2024-01-08T00:00:00.000Z" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].start.toISOString()).toBe(
      "2024-01-01T00:00:00.000Z"
    );
    expect(result.windows[0].end.toISOString()).toBe(
      "2024-01-08T00:00:00.000Z"
    );
  });

  it("merges adjacent windows (end === next start) into one union", () => {
    const result = mergeFreezeWindows([
      { start: "2024-01-01T00:00:00.000Z", end: "2024-01-05T00:00:00.000Z" },
      { start: "2024-01-05T00:00:00.000Z", end: "2024-01-09T00:00:00.000Z" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].end.toISOString()).toBe(
      "2024-01-09T00:00:00.000Z"
    );
  });

  it("rejects malformed windows with a stable reason code", () => {
    const result = mergeFreezeWindows([
      { start: "not-a-date", end: "2024-01-05T00:00:00.000Z" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_window");
    expect(result.windows).toHaveLength(0);
  });

  it("rejects inverted windows (start after end) with a stable reason code", () => {
    const result = mergeFreezeWindows([
      { start: "2024-01-05T00:00:00.000Z", end: "2024-01-01T00:00:00.000Z" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("inverted_window");
  });

  it("rejects oversized input with a stable reason code", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      start: new Date(Date.UTC(2024, 0, 1 + i * 2)).toISOString(),
      end: new Date(Date.UTC(2024, 0, 2 + i * 2)).toISOString(),
    }));

    const result = mergeFreezeWindows(many);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_many_windows");
  });

  it("returns an empty ok result for empty input", () => {
    const result = mergeFreezeWindows([]);
    expect(result.ok).toBe(true);
    expect(result.windows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isFreezeWindowActive
// ---------------------------------------------------------------------------

describe("isFreezeWindowActive — inactive scenarios", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: false when FREEZE_WINDOW_ENABLED is 'false'", () => {
    process.env.FREEZE_WINDOW_ENABLED = "false";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_START is missing", () => {
    delete process.env.FREEZE_WINDOW_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_END is missing", () => {
    process.env.FREEZE_WINDOW_START = PAST_START;
    delete process.env.FREEZE_WINDOW_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when both date env vars are missing", () => {
    delete process.env.FREEZE_WINDOW_START;
    delete process.env.FREEZE_WINDOW_END;

    expect(isFreezeWindowActive(new Date()).active).toBe(false);
  });

  it("returns active: false when now is before the freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(BEFORE_WINDOW).active).toBe(false);
  });

  it("returns active: false when now is after the freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(AFTER_WINDOW).active).toBe(false);
  });
});

describe("isFreezeWindowActive — active scenario", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: true when now is inside the freeze window", () => {
    const status = isFreezeWindowActive(INSIDE_WINDOW);
    expect(status.active).toBe(true);
    expect(status.reason).toBeTruthy();
    expect(status.reason).toMatch(/freeze window/i);
  });

  it("includes start and end Date objects on the active status", () => {
    const status = isFreezeWindowActive(INSIDE_WINDOW);
    expect(status.start).toBeInstanceOf(Date);
    expect(status.end).toBeInstanceOf(Date);
    expect(status.start?.toISOString()).toBe(new Date(PAST_START).toISOString());
    expect(status.end?.toISOString()).toBe(new Date(PAST_END).toISOString());
  });

  it("treats the exact start boundary as active (inclusive)", () => {
    const exactStart = new Date(PAST_START);
    expect(isFreezeWindowActive(exactStart).active).toBe(true);
  });

  it("treats the exact end boundary as active (inclusive)", () => {
    const exactEnd = new Date(PAST_END);
    expect(isFreezeWindowActive(exactEnd).active).toBe(true);
  });
});

describe("isFreezeWindowActive — misconfigured / invalid env (edge cases)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: false when FREEZE_WINDOW_START is an invalid date string", () => {
    process.env.FREEZE_WINDOW_START = "not-a-date";
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_END is an invalid date string", () => {
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = "INVALID_DATE";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when both dates are invalid strings", () => {
    process.env.FREEZE_WINDOW_START = "bad";
    process.env.FREEZE_WINDOW_END = "bad";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when dates are empty strings", () => {
    process.env.FREEZE_WINDOW_START = "   ";
    process.env.FREEZE_WINDOW_END = "   ";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when start is after end (inverted window)", () => {
    // Start > End means no moment is simultaneously >= start AND <= end
    process.env.FREEZE_WINDOW_START = PAST_END;
    process.env.FREEZE_WINDOW_END = PAST_START;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceFreezeWindowGuard — feature flag disabled
// ---------------------------------------------------------------------------

describe("enforceFreezeWindowGuard — feature flag disabled", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Active freeze window in env...
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
    // ...but the feature flag is turned off
    process.env.FEATURE_FLAG_FREEZE_WINDOW = "false";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not block when freeze_window feature flag is disabled", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-1",
      userLogin: "contributor",
    });

    expect(guard.blocked).toBe(false);
  });
});
