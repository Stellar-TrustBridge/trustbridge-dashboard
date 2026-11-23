import { describe, expect, it, vi } from "vitest";

import { computeJitteredDelay, withRetry } from "@/lib/retry";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
  it("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");

    await expect(
      withRetry(fn, { attempts: 3, sleep: noSleep })
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(
      withRetry(fn, { attempts: 2, sleep: noSleep })
    ).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails fast when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("404 not found"));
    await expect(
      withRetry(fn, {
        attempts: 5,
        sleep: noSleep,
        shouldRetry: (e) => !String(e).includes("404"),
      })
    ).rejects.toThrow("404");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("computeJitteredDelay", () => {
  it("grows exponentially without jitter", () => {
    expect(computeJitteredDelay(1, { delayMs: 250, backoffFactor: 2 })).toBe(250);
    expect(computeJitteredDelay(2, { delayMs: 250, backoffFactor: 2 })).toBe(500);
    expect(computeJitteredDelay(3, { delayMs: 250, backoffFactor: 2 })).toBe(1000);
  });

  it("caps the delay at maxDelayMs (the ceiling)", () => {
    // Without a ceiling the 8th attempt is 250 * 2^7 = 32000ms; the ceiling
    // bounds it so a long retry chain cannot stall delivery unbounded.
    expect(
      computeJitteredDelay(8, { delayMs: 250, backoffFactor: 2, maxDelayMs: 10_000 })
    ).toBe(10_000);
    expect(
      computeJitteredDelay(100, { delayMs: 250, backoffFactor: 2, maxDelayMs: 5_000 })
    ).toBe(5_000);
  });

  it("returns 0 for attempts below 1 and non-positive bases", () => {
    expect(computeJitteredDelay(0, { delayMs: 250 })).toBe(0);
    expect(computeJitteredDelay(-3, { delayMs: 250 })).toBe(0);
    expect(computeJitteredDelay(1, { delayMs: 0 })).toBe(0);
    expect(computeJitteredDelay(1, { delayMs: 250, backoffFactor: 0 })).toBe(0);
  });

  it("produces a full-jitter value in [0, cap] with an injectable rng", () => {
    // random() = 0 -> 0ms (floor of 0); random() near 1 -> just under cap.
    expect(computeJitteredDelay(1, { delayMs: 250, jitter: true, random: () => 0 })).toBe(0);
    expect(
      computeJitteredDelay(1, { delayMs: 250, jitter: true, random: () => 0.999 })
    ).toBe(249);
  });

  it("never exceeds maxDelayMs even with jitter", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(
        computeJitteredDelay(10, {
          delayMs: 250,
          backoffFactor: 2,
          maxDelayMs: 3_000,
          jitter: true,
          random: () => r,
        })
      ).toBeLessThanOrEqual(3_000);
    }
  });
});

describe("withRetry — jittered backoff", () => {
  it("passes the full-jitter delay to sleep on each retry", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn((ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    // Deterministic rng sequence: 0.4, then 0.8.
    const rng = vi.fn().mockReturnValueOnce(0.4).mockReturnValueOnce(0.8);
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");

    await expect(
      withRetry(fn, {
        attempts: 3,
        delayMs: 1_000,
        backoffFactor: 2,
        maxDelayMs: 10_000,
        jitter: true,
        sleep,
        random: rng,
      })
    ).resolves.toBe("ok");

    // attempt 1 failed -> wait = floor(0.4 * min(10000, 1000)) = 400
    expect(sleeps).toEqual([400]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never sleeps longer than maxDelayMs across many attempts", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn((ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(
      withRetry(fn, {
        attempts: 8,
        delayMs: 250,
        backoffFactor: 2,
        maxDelayMs: 5_000,
        jitter: true,
        random: () => 0.999, // near the top of the jitter range
        sleep,
      })
    ).rejects.toThrow("always");

    // 7 sleeps for 8 attempts (no sleep after the last failure).
    expect(sleeps).toHaveLength(7);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5_000);
  });
});
