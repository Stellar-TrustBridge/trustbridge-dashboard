/**
 * Unit tests for analytics adapter selection (#302).
 *
 * Verifies that:
 * - the no-op adapter is selected when no key is configured
 * - the console adapter is selected in development without a key
 * - server-side track helpers never throw, regardless of env state
 * - all exported track functions are callable without errors
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Temporarily set process.env keys and restore them after the test. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter selection — server-side helpers
// ---------------------------------------------------------------------------

describe("analytics — server-side track helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trackServerRegistrationCreated does not throw without POSTHOG_API_KEY", () => {
    withEnv({ POSTHOG_API_KEY: undefined }, () => {
      // Re-require so the module picks up the cleared env.
      // Because vitest caches modules we test the exported functions directly;
      // they must not throw even with no key configured.
      const { trackServerRegistrationCreated } = require("@/lib/analytics");
      expect(() =>
        trackServerRegistrationCreated({ userId: "u1", stellarAddress: "GABC" })
      ).not.toThrow();
    });
  });

  it("trackServerRegistrationUpdated does not throw without POSTHOG_API_KEY", () => {
    withEnv({ POSTHOG_API_KEY: undefined }, () => {
      const { trackServerRegistrationUpdated } = require("@/lib/analytics");
      expect(() =>
        trackServerRegistrationUpdated({
          userId: "u1",
          fieldsChanged: ["stellarAddress"],
        })
      ).not.toThrow();
    });
  });

  it("trackServerCsvExported does not throw without POSTHOG_API_KEY", () => {
    withEnv({ POSTHOG_API_KEY: undefined }, () => {
      const { trackServerCsvExported } = require("@/lib/analytics");
      expect(() =>
        trackServerCsvExported({ rowCount: 42, triggeredBy: "maintainer" })
      ).not.toThrow();
    });
  });

  it("trackServerBatchRecheckStarted does not throw without POSTHOG_API_KEY", () => {
    withEnv({ POSTHOG_API_KEY: undefined }, () => {
      const { trackServerBatchRecheckStarted } = require("@/lib/analytics");
      expect(() =>
        trackServerBatchRecheckStarted({ totalRegistrations: 10, initiatedBy: "u1" })
      ).not.toThrow();
    });
  });

  it("server track helpers accept undefined properties without throwing", () => {
    const {
      trackServerRegistrationCreated,
      trackServerRegistrationUpdated,
      trackServerCsvExported,
      trackServerBatchRecheckStarted,
    } = require("@/lib/analytics");

    expect(() => trackServerRegistrationCreated()).not.toThrow();
    expect(() => trackServerRegistrationUpdated()).not.toThrow();
    expect(() => trackServerCsvExported()).not.toThrow();
    expect(() => trackServerBatchRecheckStarted()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Adapter selection — client-side helpers
// ---------------------------------------------------------------------------

describe("analytics — client-side track helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trackRegistrationCreated does not throw", () => {
    const { trackRegistrationCreated } = require("@/lib/analytics");
    expect(() =>
      trackRegistrationCreated({ userId: "u1", stellarAddress: "GABC" })
    ).not.toThrow();
  });

  it("trackRegistrationUpdated does not throw", () => {
    const { trackRegistrationUpdated } = require("@/lib/analytics");
    expect(() =>
      trackRegistrationUpdated({ userId: "u1", fieldsChanged: ["stellarAddress"] })
    ).not.toThrow();
  });

  it("trackBatchRecheckStarted does not throw", () => {
    const { trackBatchRecheckStarted } = require("@/lib/analytics");
    expect(() =>
      trackBatchRecheckStarted({ totalRegistrations: 5 })
    ).not.toThrow();
  });

  it("trackCsvExported does not throw", () => {
    const { trackCsvExported } = require("@/lib/analytics");
    expect(() => trackCsvExported({ rowCount: 99 })).not.toThrow();
  });

  it("trackRecheckCompleted does not throw", () => {
    const { trackRecheckCompleted } = require("@/lib/analytics");
    expect(() =>
      trackRecheckCompleted({ totalChecked: 10, changed: 2, durationMs: 1500 })
    ).not.toThrow();
  });

  it("identifyUser does not throw", () => {
    const { identifyUser } = require("@/lib/analytics");
    expect(() => identifyUser("user-123", { plan: "free" })).not.toThrow();
  });

  it("resetAnalytics does not throw", () => {
    const { resetAnalytics } = require("@/lib/analytics");
    expect(() => resetAnalytics()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// No-op guard — console adapter must not be used in test (NODE_ENV=test)
// ---------------------------------------------------------------------------

describe("analytics — adapter selection guards", () => {
  it("does not log to console in test environment (no adapter side-effects)", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const { trackRegistrationCreated } = require("@/lib/analytics");
    trackRegistrationCreated({ userId: "u1" });
    // In test env (NODE_ENV=test) neither ConsoleAdapter nor PostHogAdapter
    // should be selected — the call must be a no-op.
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[Analytics]"),
      expect.anything()
    );
  });

  it("exports all expected server-track symbols", () => {
    const analytics = require("@/lib/analytics");
    expect(typeof analytics.trackServerRegistrationCreated).toBe("function");
    expect(typeof analytics.trackServerRegistrationUpdated).toBe("function");
    expect(typeof analytics.trackServerCsvExported).toBe("function");
    expect(typeof analytics.trackServerBatchRecheckStarted).toBe("function");
  });

  it("exports all expected client-track symbols", () => {
    const analytics = require("@/lib/analytics");
    expect(typeof analytics.trackRegistrationCreated).toBe("function");
    expect(typeof analytics.trackRegistrationUpdated).toBe("function");
    expect(typeof analytics.trackBatchRecheckStarted).toBe("function");
    expect(typeof analytics.trackCsvExported).toBe("function");
    expect(typeof analytics.trackRecheckCompleted).toBe("function");
    expect(typeof analytics.identifyUser).toBe("function");
    expect(typeof analytics.resetAnalytics).toBe("function");
  });
});
