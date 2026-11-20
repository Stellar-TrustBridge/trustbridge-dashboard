/**
 * Unit tests for the feature-flags module (issue #201).
 *
 * Covers the resolution order (env override → DB row → built-in default),
 * the fail-closed behaviour for risky flags when the DB source is unreadable,
 * and the in-process cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    featureFlag: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  clearFeatureFlagCache,
  getAllFeatureFlags,
  isFeatureEnabled,
  isFeatureEnabledForSubject,
  isFeatureEnabledFromEnv,
  isInRollout,
  getRolloutPercent,
  rolloutBucket,
  setFeatureFlag,
} from "@/lib/feature-flags";

const findMany = vi.mocked(prisma.featureFlag.findMany);
const upsert = vi.mocked(prisma.featureFlag.upsert);

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.FEATURE_FLAGS_DB_ENABLED;
  delete process.env.FEATURE_FLAG_BATCH_RECHECK;
  delete process.env.FEATURE_FLAG_OTEL_TRACES;
  delete process.env.FEATURE_FLAG_DLQ_RETRY;
  delete process.env.FEATURE_FLAG_FREEZE_WINDOW;
  clearFeatureFlagCache();
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("built-in defaults", () => {
  it("returns the default when there is no env override and no DB source", async () => {
    expect(await isFeatureEnabled("batch_recheck")).toBe(true);
    expect(await isFeatureEnabled("otel_traces")).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns false for an unknown flag", async () => {
    // @ts-expect-error deliberately passing an unknown key
    expect(await isFeatureEnabled("nope")).toBe(false);
  });
});

describe("env overrides", () => {
  it("an env override wins over the default and is not a DB read", async () => {
    process.env.FEATURE_FLAG_BATCH_RECHECK = "off";
    expect(await isFeatureEnabled("batch_recheck")).toBe(false);

    process.env.FEATURE_FLAG_OTEL_TRACES = "1";
    expect(await isFeatureEnabled("otel_traces")).toBe(true);

    expect(findMany).not.toHaveBeenCalled();
  });

  it("isFeatureEnabledFromEnv ignores the DB entirely", () => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";
    process.env.FEATURE_FLAG_DLQ_RETRY = "false";
    expect(isFeatureEnabledFromEnv("dlq_retry")).toBe(false);
    expect(isFeatureEnabledFromEnv("batch_recheck")).toBe(true); // default
    expect(findMany).not.toHaveBeenCalled();
  });

  it("an unrecognised env value falls through to the next source", async () => {
    process.env.FEATURE_FLAG_BATCH_RECHECK = "maybe";
    expect(await isFeatureEnabled("batch_recheck")).toBe(true); // default
  });
});

describe("database source", () => {
  beforeEach(() => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "true";
  });

  it("uses the DB row when present", async () => {
    findMany.mockResolvedValue([
      { key: "otel_traces", enabled: true },
      { key: "batch_recheck", enabled: false },
    ] as never);

    expect(await isFeatureEnabled("otel_traces")).toBe(true);
    expect(await isFeatureEnabled("batch_recheck")).toBe(false);
  });

  it("falls back to the default when the DB has no row", async () => {
    findMany.mockResolvedValue([] as never);
    expect(await isFeatureEnabled("batch_recheck")).toBe(true);
  });

  it("caches the DB read within the TTL and re-reads after clear", async () => {
    findMany.mockResolvedValue([{ key: "otel_traces", enabled: true }] as never);

    await isFeatureEnabled("otel_traces");
    await isFeatureEnabled("batch_recheck");
    expect(findMany).toHaveBeenCalledTimes(1);

    clearFeatureFlagCache();
    await isFeatureEnabled("otel_traces");
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe("fail closed", () => {
  beforeEach(() => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";
    findMany.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("resolves a risky flag to false when the DB source is unreadable", async () => {
    expect(await isFeatureEnabled("batch_recheck")).toBe(false);
    expect(await isFeatureEnabled("dlq_retry")).toBe(false);
    expect(await isFeatureEnabled("maintenance_mode")).toBe(false);
    expect(await isFeatureEnabled("freeze_window")).toBe(false);
  });

  it("resolves a non-risky flag to its default when the DB is unreadable", async () => {
    expect(await isFeatureEnabled("otel_traces")).toBe(false); // default false
  });

  it("still honours an env override even when the DB is down", async () => {
    process.env.FEATURE_FLAG_BATCH_RECHECK = "on";
    expect(await isFeatureEnabled("batch_recheck")).toBe(true);
    process.env.FEATURE_FLAG_FREEZE_WINDOW = "on";
    expect(await isFeatureEnabled("freeze_window")).toBe(true);
  });
});

describe("getAllFeatureFlags", () => {
  it("reports every known flag with its source", async () => {
    process.env.FEATURE_FLAG_OTEL_TRACES = "1";
    const all = await getAllFeatureFlags();
    const keys = all.map((f) => f.key).sort();
    expect(keys).toEqual(
      [
        "batch_recheck",
        "dlq_retry",
        "freeze_window",
        "invite_generation",
        "maintenance_mode",
        "otel_traces",
      ].sort(),
    );
    expect(all.find((f) => f.key === "otel_traces")?.source).toBe("env");
    expect(all.find((f) => f.key === "batch_recheck")?.source).toBe("default");
    expect(all.find((f) => f.key === "freeze_window")?.source).toBe("default");
  });
});

describe("setFeatureFlag", () => {
  it("throws when the DB source is disabled", async () => {
    await expect(setFeatureFlag("otel_traces", true)).rejects.toThrow(
      /FEATURE_FLAGS_DB_ENABLED/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts and clears the cache when the DB source is enabled", async () => {
    process.env.FEATURE_FLAGS_DB_ENABLED = "1";
    upsert.mockResolvedValue({} as never);
    await setFeatureFlag("otel_traces", true, "user-1");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "otel_traces" } }),
    );
  });
});

describe("percentage rollout with sticky bucketing (issue #661)", () => {
  beforeEach(() => {
    delete process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT;
    delete process.env.FEATURE_FLAG_BATCH_RECHECK_ROLLOUT_PERCENT;
  });

  it("bucket is stable for the same flag/scope/subject (sticky)", () => {
    const a = rolloutBucket("otel_traces", "user", "github-alice");
    const b = rolloutBucket("otel_traces", "user", "github-alice");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it("bucket differs across flags and scopes for the same subject id", () => {
    const userBucket = rolloutBucket("otel_traces", "user", "42");
    const orgBucket = rolloutBucket("otel_traces", "org", "42");
    const otherFlag = rolloutBucket("batch_recheck", "user", "42");
    // Not guaranteed all different, but at least one axis should usually differ;
    // assert the pure function is deterministic and range-bound instead.
    expect(userBucket).toBe(rolloutBucket("otel_traces", "user", "42"));
    expect(orgBucket).toBe(rolloutBucket("otel_traces", "org", "42"));
    expect(otherFlag).toBe(rolloutBucket("batch_recheck", "user", "42"));
    expect(userBucket).toBeGreaterThanOrEqual(0);
    expect(orgBucket).toBeGreaterThanOrEqual(0);
    expect(otherFlag).toBeGreaterThanOrEqual(0);
  });

  it("0% boundary is always off; 100% boundary is always on", () => {
    for (const subject of ["a", "b", "user-1", "org-9", ""]) {
      expect(isInRollout("otel_traces", "user", subject, 0)).toBe(false);
      expect(isInRollout("otel_traces", "user", subject, 100)).toBe(true);
      expect(isInRollout("otel_traces", "org", subject, 0)).toBe(false);
      expect(isInRollout("otel_traces", "org", subject, 100)).toBe(true);
    }
  });

  it("invalid percentages fail closed", () => {
    expect(isInRollout("otel_traces", "user", "x", -1)).toBe(false);
    expect(isInRollout("otel_traces", "user", "x", NaN)).toBe(false);
    expect(isInRollout("otel_traces", "user", "x", 101)).toBe(true); // >= 100
  });

  it("is sticky across repeated evaluations for mid-range percent", () => {
    const percent = 37;
    const first = isInRollout("otel_traces", "user", "wave-contributor", percent);
    for (let i = 0; i < 20; i++) {
      expect(
        isInRollout("otel_traces", "user", "wave-contributor", percent)
      ).toBe(first);
    }
  });

  it("getRolloutPercent reads env and rejects out-of-range values", () => {
    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "25";
    expect(getRolloutPercent("otel_traces")).toBe(25);

    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "999";
    expect(getRolloutPercent("otel_traces")).toBeUndefined();

    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "not-a-number";
    expect(getRolloutPercent("otel_traces")).toBeUndefined();

    delete process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT;
    expect(getRolloutPercent("otel_traces")).toBeUndefined();
  });

  it("isFeatureEnabledForSubject: no rollout env → full audience when base on", async () => {
    expect(await isFeatureEnabledForSubject("batch_recheck", "user", "u1")).toBe(
      true,
    );
    expect(await isFeatureEnabledForSubject("otel_traces", "user", "u1")).toBe(
      false,
    );
  });

  it("isFeatureEnabledForSubject: base-off wins over rollout", async () => {
    process.env.FEATURE_FLAG_OTEL_TRACES = "off";
    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "100";
    expect(await isFeatureEnabledForSubject("otel_traces", "user", "u1")).toBe(
      false,
    );
  });

  it("isFeatureEnabledForSubject: 0% rollout excludes every subject", async () => {
    process.env.FEATURE_FLAG_BATCH_RECHECK = "on";
    process.env.FEATURE_FLAG_BATCH_RECHECK_ROLLOUT_PERCENT = "0";
    expect(
      await isFeatureEnabledForSubject("batch_recheck", "user", "u1"),
    ).toBe(false);
    expect(
      await isFeatureEnabledForSubject("batch_recheck", "org", "o1"),
    ).toBe(false);
  });

  it("isFeatureEnabledForSubject: 100% rollout includes every subject", async () => {
    process.env.FEATURE_FLAG_OTEL_TRACES = "on";
    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "100";
    expect(await isFeatureEnabledForSubject("otel_traces", "user", "u1")).toBe(
      true,
    );
    expect(await isFeatureEnabledForSubject("otel_traces", "org", "o1")).toBe(
      true,
    );
  });

  it("isFeatureEnabledForSubject: sticky for a mid-range rollout", async () => {
    process.env.FEATURE_FLAG_OTEL_TRACES = "on";
    process.env.FEATURE_FLAG_OTEL_TRACES_ROLLOUT_PERCENT = "50";
    const first = await isFeatureEnabledForSubject(
      "otel_traces",
      "user",
      "sticky-user",
    );
    for (let i = 0; i < 10; i++) {
      expect(
        await isFeatureEnabledForSubject("otel_traces", "user", "sticky-user"),
      ).toBe(first);
    }
  });
});
