import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hashIdentifier,
  isAnalyticsEnabled,
  parseAnalyticsBool,
  ANALYTICS_EVENT_TYPES,
} from "@/lib/analytics-policy";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

const ENV_KEYS = [
  "ANALYTICS_OPT_OUT",
  "NEXT_PUBLIC_ANALYTICS_OPT_OUT",
  "ANALYTICS_ENABLED",
  "NEXT_PUBLIC_ANALYTICS_ENABLED",
  "FEATURE_FLAG_ANALYTICS",
  "NEXT_PUBLIC_FEATURE_FLAG_ANALYTICS",
  "ANALYTICS_HASH_SALT",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_API_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
];

type Overrides = Record<string, string | undefined>;

async function withAnalytics<T>(
  overrides: Overrides,
  fn: (analytics: typeof import("@/lib/analytics")) => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  try {
    const analytics = await import("@/lib/analytics");
    return await fn(analytics);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

async function inBrowser<T>(
  overrides: Overrides,
  fn: (
    analytics: typeof import("@/lib/analytics"),
    posthog: typeof import("posthog-js"),
  ) => T | Promise<T>,
): Promise<T> {
  vi.stubGlobal("window", {});
  return withAnalytics(
    { NEXT_PUBLIC_POSTHOG_API_KEY: "browser-key", ...overrides },
    async (analytics) => {
      const posthog = await import("posthog-js");
      return fn(analytics, posthog);
    },
  );
}

function fetchRecorder() {
  const bodies: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  });
  return { spy, bodies, payloads: () => bodies.map((body) => JSON.parse(body)) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("analytics policy", () => {
  it("parses boolean env values safely", () => {
    expect(parseAnalyticsBool(" ON ")).toBe(true);
    expect(parseAnalyticsBool("Yes")).toBe(true);
    expect(parseAnalyticsBool("1")).toBe(true);
    expect(parseAnalyticsBool("off")).toBe(false);
    expect(parseAnalyticsBool("DISABLED")).toBe(false);
    expect(parseAnalyticsBool("maybe")).toBeUndefined();
    expect(parseAnalyticsBool("")).toBeUndefined();
    expect(parseAnalyticsBool(undefined)).toBeUndefined();
  });

  it("honours kill switches, opt-ins and the feature-flag env override", () => {
    withEnv(isAnalyticsEnabled, { ANALYTICS_OPT_OUT: "1" }, false);
    withEnv(isAnalyticsEnabled, { NEXT_PUBLIC_ANALYTICS_OPT_OUT: "true" }, false);
    withEnv(isAnalyticsEnabled, { ANALYTICS_ENABLED: "false" }, false);
    withEnv(isAnalyticsEnabled, { NEXT_PUBLIC_ANALYTICS_ENABLED: "0" }, false);
    withEnv(isAnalyticsEnabled, { FEATURE_FLAG_ANALYTICS: "off" }, false);
    withEnv(isAnalyticsEnabled, { NEXT_PUBLIC_FEATURE_FLAG_ANALYTICS: "no" }, false);
    withEnv(isAnalyticsEnabled, { ANALYTICS_ENABLED: "yes" }, true);
    withEnv(isAnalyticsEnabled, {}, true);
    withEnv(isAnalyticsEnabled, { ANALYTICS_ENABLED: "nonsense" }, true);
    withEnv(
      isAnalyticsEnabled,
      { ANALYTICS_ENABLED: "on", ANALYTICS_OPT_OUT: "yes" },
      false,
    );
  });

  it("hashes durable identifiers deterministically without the raw value", () => {
    const hashed = hashIdentifier("alice");
    expect(hashed).toMatch(/^anon_[0-9a-f]{16}$/);
    expect(hashed).toBe(hashIdentifier("  ALICE  "));
    expect(hashed).not.toContain("alice");
    expect(hashIdentifier("")).toBe("");
  });

  it("publishes a schema for every event type", () => {
    expect(ANALYTICS_EVENT_TYPES).toHaveLength(8);
    expect(ANALYTICS_EVENT_TYPES).toContain("dispute_closed");
  });
});

function withEnv(fn: () => boolean, overrides: Overrides, expected: boolean) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    expect(fn()).toBe(expected);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("analytics — opt-out suppresses every emit path", () => {
  it("browser PostHog emits nothing when opted out", async () => {
    await inBrowser({ ANALYTICS_OPT_OUT: "1" }, async (analytics, posthog) => {
      analytics.trackRegistrationCreated({ userId: "user-1", stellarAddress: "GABC" });
      analytics.identifyUser("user-1", { githubUsername: "alice" });
      analytics.resetAnalytics();
      expect(posthog.default.init).not.toHaveBeenCalled();
      expect(posthog.default.capture).not.toHaveBeenCalled();
      expect(posthog.default.identify).not.toHaveBeenCalled();
      expect(posthog.default.reset).not.toHaveBeenCalled();
    });
  });


  it("console adapter emits nothing when opted out", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    vi.stubGlobal("window", {});
    try {
      await withAnalytics(
        { ANALYTICS_OPT_OUT: "true" },
        async ({ trackRegistrationCreated, identifyUser }) => {
          trackRegistrationCreated({ userId: "user-1" });
          identifyUser("user-1", { githubUsername: "alice" });
        },
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("server track and identify emit nothing via trackServerEvent path", async () => {
    const recorder = fetchRecorder();
    await withAnalytics(
      { POSTHOG_API_KEY: "server-key", NEXT_PUBLIC_ANALYTICS_OPT_OUT: "1" },
      async ({ trackServerEvent, identifyServerUser }) => {
        trackServerEvent("registration_created", { userId: "user-1" });
        identifyServerUser("user-1", { maintainerOrgId: "org-1" });
      },
    );
    expect(recorder.spy).not.toHaveBeenCalled();
  });

  it("identifyServerUser emits nothing when opted out directly", async () => {
    const recorder = fetchRecorder();
    await withAnalytics(
      { POSTHOG_API_KEY: "server-key", ANALYTICS_OPT_OUT: "1" },
      ({ identifyServerUser }) => {
        identifyServerUser("user-1", { maintainerOrgId: "org-1" });
      },
    );
    expect(recorder.spy).not.toHaveBeenCalled();
  });

  it("a disabled feature flag env override suppresses emits", async () => {
    const recorder = fetchRecorder();
    await withAnalytics(
      { POSTHOG_API_KEY: "server-key", FEATURE_FLAG_ANALYTICS: "off" },
      ({ trackServerCsvExported }) => {
        trackServerCsvExported({ rowCount: 10 });
      },
    );
    expect(recorder.spy).not.toHaveBeenCalled();
  });
});

describe("analytics — no-PII event schema", () => {
  it("browser capture drops raw identifiers, addresses and unknown properties", async () => {
    await inBrowser({}, async ({ trackRegistrationCreated }, posthog) => {
      trackRegistrationCreated({
        userId: "user-123",
        stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      });

      await vi.waitFor(() => {
        expect(posthog.default.capture).toHaveBeenCalledTimes(1);
      });
      const [event, properties] = (posthog.default.capture as any).mock.calls[0];
      expect(event).toBe("registration_created");
      expect(properties).toEqual({ userId: hashIdentifier("user-123") });
      expect(JSON.stringify(properties)).not.toContain("stellarAddress");
      expect(JSON.stringify(properties)).not.toContain("GAAAAAAAA");
    });
  });

  it("browser identify hashes userId and githubUsername", async () => {
    await inBrowser({}, async ({ identifyUser }, posthog) => {
      identifyUser("user-456", {
        githubUsername: "alice",
        maintainerOrgId: "stellar-org",
        role: "maintainer",
        email: "alice@example.com",
        notes: "private note",
      });

      await vi.waitFor(() => {
        expect(posthog.default.identify).toHaveBeenCalledTimes(1);
      });
      const [distinctId, properties] = (posthog.default.identify as any).mock.calls[0];
      expect(distinctId).toBe(hashIdentifier("user-456"));
      expect(properties).toEqual({
        maintainerOrgId: "stellar-org",
        githubUsername: hashIdentifier("alice"),
        role: "maintainer",
      });
      expect(JSON.stringify(properties)).not.toContain("alice");
      expect(JSON.stringify(properties)).not.toContain("example.com");
    });
  });

  it("console adapter logs only sanitized properties", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    vi.stubGlobal("window", {});
    try {
      await withAnalytics({}, async ({ trackServerEvent }) => {
        trackServerEvent("registration_created", {
          userId: "dev-user",
          stellarAddress: "GSECRET",
          email: "dev@example.com",
        });
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
    expect(consoleSpy).toHaveBeenCalledWith("[Analytics] registration_created", {
      userId: hashIdentifier("dev-user"),
    });
  });

  it("server track sanitizes properties and uses the hashed id as distinct_id", async () => {
    const recorder = fetchRecorder();
    await withAnalytics(
      { POSTHOG_API_KEY: "server-key" },
      ({ trackServerRegistrationCreated }) => {
        trackServerRegistrationCreated({
          userId: "user-789",
          stellarAddress: "GSECRETADDRESS",
        });
      },
    );

    expect(recorder.spy).toHaveBeenCalledTimes(1);
    const payload = recorder.payloads()[0];
    expect(payload.event).toBe("registration_created");
    expect(payload.distinct_id).toBe(hashIdentifier("user-789"));
    expect(payload.properties).toEqual({
      userId: hashIdentifier("user-789"),
      $lib: "trustbridge-server",
    });
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("user-789");
    expect(raw).not.toContain("GSECRETADDRESS");
    expect(raw).not.toContain("stellarAddress");
  });

  it("applies the allowlist to every event type", async () => {
    const recorder = fetchRecorder();
    const inputs: Record<string, Record<string, unknown>> = {
      registration_created: { userId: "u1", stellarAddress: "GSECRET" },
      registration_updated: {
        userId: "u2",
        fieldsChanged: ["profile", "stellarAddress", "notes"],
      },
      recheck_completed: { totalChecked: 10, changed: 2, durationMs: 1500, notes: "x" },
      batch_recheck_started: { totalRegistrations: 5, initiatedBy: "u3" },
      csv_exported: { rowCount: 42, triggeredBy: "u4" },
      soroban_mirror_completed: { success: true, durationMs: 12, txHash: "secret-hash" },
      dispute_opened: {
        userId: "u5",
        disputeId: "d1",
        registrationId: "r1",
        actorRole: "maintainer",
        hasProof: true,
        note: "private",
      },
      dispute_closed: { userId: "u6", disputeId: "d2", status: "VALIDATED", email: "a@b.co" },
    };

    await withAnalytics({ POSTHOG_API_KEY: "server-key" }, async ({ trackServerEvent }) => {
      for (const event of ANALYTICS_EVENT_TYPES) {
        trackServerEvent(event, inputs[event]);
      }
    });

    const payloads = recorder.payloads();
    expect(payloads).toHaveLength(ANALYTICS_EVENT_TYPES.length);
    for (const payload of payloads) {
      const raw = JSON.stringify(payload);
      expect(raw).not.toMatch(/GSECRET|a@b\.co|secret-hash|private|"notes"|"email"/);
    }
    expect(payloads.find((p) => p.event === "recheck_completed").properties).toMatchObject({
      totalChecked: 10,
      changed: 2,
      durationMs: 1500,
    });
    expect(payloads.find((p) => p.event === "registration_updated").properties.fieldsChanged).toEqual([
      "profile",
    ]);
    expect(payloads.find((p) => p.event === "dispute_closed").properties.status).toBe("VALIDATED");
  });

  it("server identify hashes durable identifiers and keeps org scope", async () => {
    const recorder = fetchRecorder();
    await withAnalytics(
      { POSTHOG_API_KEY: "server-key" },
      ({ identifyServerUser }) => {
        identifyServerUser("user-456", {
          maintainerOrgId: "org-stellar",
          githubUsername: "alice",
          role: "maintainer",
        });
      },
    );

    const payload = recorder.payloads()[0];
    expect(payload.event).toBe("$identify");
    expect(payload.distinct_id).toBe(hashIdentifier("user-456"));
    expect(payload.$set).toEqual({
      maintainerOrgId: "org-stellar",
      githubUsername: hashIdentifier("alice"),
      role: "maintainer",
      $lib: "trustbridge-server",
    });
    expect(payload.$groups).toEqual({ organisation: "org-stellar" });
    expect(JSON.stringify(payload)).not.toContain("alice");
    expect(JSON.stringify(payload)).not.toContain("user-456");
  });

  it("identifyServerUser is a no-op for anonymous or empty ids", async () => {
    const recorder = fetchRecorder();
    await withAnalytics({ POSTHOG_API_KEY: "server-key" }, ({ identifyServerUser }) => {
      identifyServerUser("anonymous", { maintainerOrgId: "org-1" });
      identifyServerUser("", { maintainerOrgId: "org-1" });
    });
    expect(recorder.spy).not.toHaveBeenCalled();
  });

  it("identifyServerUser omits $groups without an org and never throws on fetch failure", async () => {
    const recorder = fetchRecorder();
    await withAnalytics({ POSTHOG_API_KEY: "server-key" }, ({ identifyServerUser }) => {
      identifyServerUser("user-789", { role: "maintainer" });
    });
    expect(recorder.payloads()[0].$groups).toBeUndefined();

    recorder.spy.mockRejectedValue(new Error("Network error"));
    await withAnalytics({ POSTHOG_API_KEY: "server-key" }, ({ identifyServerUser }) => {
      expect(() => identifyServerUser("user-abc", { maintainerOrgId: "org-x" })).not.toThrow();
    });
  });

  it("server track helpers remain callable with no key configured", async () => {
    await withAnalytics({}, (analytics) => {
      expect(() => analytics.trackServerRegistrationCreated()).not.toThrow();
      expect(() => analytics.trackServerRegistrationUpdated()).not.toThrow();
      expect(() => analytics.trackServerCsvExported()).not.toThrow();
      expect(() => analytics.trackServerBatchRecheckStarted()).not.toThrow();
      expect(() => analytics.trackServerDisputeOpened()).not.toThrow();
      expect(() => analytics.trackServerDisputeClosed()).not.toThrow();
      expect(() => analytics.trackRegistrationCreated()).not.toThrow();
      expect(() => analytics.trackRegistrationUpdated()).not.toThrow();
      expect(() => analytics.trackBatchRecheckStarted()).not.toThrow();
      expect(() => analytics.trackCsvExported()).not.toThrow();
      expect(() => analytics.trackRecheckCompleted()).not.toThrow();
      expect(() => analytics.trackSorobanMirrorCompleted()).not.toThrow();
      expect(() => analytics.resetAnalytics()).not.toThrow();
    });
  });
});
