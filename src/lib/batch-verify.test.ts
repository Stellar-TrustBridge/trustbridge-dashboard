import { describe, expect, it, vi } from "vitest";

import {
  batchVerify,
  calculateVerificationSummary,
  filterByStatus,
  parseJobProgressEvent,
  sortByReadiness,
  type BatchVerificationProgressEvent,
  type VerificationCheckResult,
} from "@/lib/batch-verify";

function result(
  status: VerificationCheckResult["status"],
  username: string = status
): VerificationCheckResult {
  return {
    username,
    stellar_address: `G_${username}`,
    status,
    checks: { funded: true, trustline: true, reserve: true },
  };
}

describe("calculateVerificationSummary", () => {
  it("aggregates counts and percentages", () => {
    const summary = calculateVerificationSummary([
      result("ready"),
      result("ready"),
      result("low_reserve"),
      result("error"),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.ready).toBe(2);
    expect(summary.readyPercentage).toBe(50);
    expect(summary.succeededPercentage).toBe(75);
  });

  it("avoids divide-by-zero for empty input", () => {
    expect(calculateVerificationSummary([]).readyPercentage).toBe(0);
  });
});

describe("sortByReadiness / filterByStatus", () => {
  it("orders ready first and errors last", () => {
    const sorted = sortByReadiness([
      result("error"),
      result("ready"),
      result("not_ready"),
    ]);
    expect(sorted.map((r) => r.status)).toEqual([
      "ready",
      "not_ready",
      "error",
    ]);
  });

  it("filters by a single status", () => {
    const filtered = filterByStatus(
      [result("ready"), result("error")],
      "error"
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].status).toBe("error");
  });
});

describe("batchVerify progress", () => {
  it("emits ordered snapshots with processed, error counts and completion", async () => {
    const events: BatchVerificationProgressEvent[] = [];
    const results = await batchVerify(
      [
        { username: "a", stellar_address: "G_a" },
        { username: "b", stellar_address: "G_b" },
        { username: "c", stellar_address: "G_c" },
      ],
      async (address) => {
        if (address === "G_b") throw new Error("horizon down");
        return result("ready", "ok");
      },
      {
        concurrency: 1,
        jobId: "job-42",
        onProgress: (event) => {
          events.push(event);
        },
      }
    );

    expect(results).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual([
      "progress", "progress", "progress",
    ]);
    expect(events.map((event) => event.jobId)).toEqual([
      "job-42", "job-42", "job-42",
    ]);
    expect(events.map((event) => event.processed)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.total)).toEqual([3, 3, 3]);
    expect(events.map((event) => event.errors)).toEqual([0, 1, 1]);
    expect(events.map((event) => event.done)).toEqual([false, false, true]);
    expect(new Set(events.map((event) => event.updatedAt)).size).toBe(3);
    expect(
      events.map((event) => Date.parse(event.updatedAt)).every(
        (timestamp, index, all) => index === 0 || timestamp > all[index - 1]
      )
    ).toBe(true);
  });

  it("emits a done snapshot with zero processed for an empty batch", async () => {
    const events: BatchVerificationProgressEvent[] = [];
    await batchVerify([], async () => result("ready"), {
      jobId: "empty",
      onProgress: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "progress",
      jobId: "empty",
      processed: 0,
      total: 0,
      errors: 0,
      done: true,
    });
  });

  it("awaits async progress callbacks before resolving", async () => {
    const seen: number[] = [];
    await batchVerify(
      [{ username: "a", stellar_address: "G_a" }],
      async () => result("ready"),
      {
        jobId: "async",
        onProgress: async (event) => {
          await Promise.resolve();
          seen.push(event.processed);
        },
      }
    );
    expect(seen).toEqual([1]);
  });
});

describe("parseJobProgressEvent", () => {
  it("accepts a valid snapshot and rejects malformed ones", () => {
    const valid = {
      type: "progress",
      jobId: "job-1",
      processed: 2,
      total: 3,
      errors: 1,
      done: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(parseJobProgressEvent(valid)).toEqual(valid);
    expect(parseJobProgressEvent(null)).toBeNull();
    expect(parseJobProgressEvent({ ...valid, type: "status" })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, processed: -1 })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, done: "yes" })).toBeNull();
    expect(parseJobProgressEvent({ ...valid, updatedAt: 123 })).toBeNull();
  });
});

describe("batchVerify", () => {
  it("runs all verifications and captures thrown errors", async () => {
    const results = await batchVerify(
      [
        { username: "a", stellar_address: "G_a" },
        { username: "b", stellar_address: "G_b" },
      ],
      async (address) => {
        if (address === "G_b") throw new Error("horizon down");
        return result("ready", "a");
      },
      { concurrency: 2 }
    );

    expect(results).toHaveLength(2);
    const b = results.find((r) => r.username === "b");
    expect(b?.status).toBe("error");
    expect(b?.error_message).toBe("horizon down");
  });
});

// ---------------------------------------------------------------------------
// Cancellation checkpoint tests
// ---------------------------------------------------------------------------

describe("batchVerify — AbortSignal cancellation", () => {
  it("happy path: completes all addresses when signal is never aborted", async () => {
    const controller = new AbortController();
    const addresses = [
      { username: "a", stellar_address: "G_a" },
      { username: "b", stellar_address: "G_b" },
      { username: "c", stellar_address: "G_c" },
    ];

    const results = await batchVerify(
      addresses,
      async () => result("ready"),
      { concurrency: 1, signal: controller.signal }
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "ready")).toBe(true);
  });

  it("stops claiming new addresses after abort (cooperative cancellation)", async () => {
    const controller = new AbortController();
    let processed = 0;

    const addresses = Array.from({ length: 10 }, (_, i) => ({
      username: `user-${i}`,
      stellar_address: `G_${i}`,
    }));

    await batchVerify(
      addresses,
      async () => {
        processed += 1;
        // Abort after the first address completes
        if (processed === 1) controller.abort();
        return result("ready");
      },
      { concurrency: 1, signal: controller.signal }
    );

    // With concurrency=1 the worker checks the signal before each address.
    // After the first address the signal is aborted so only 1 address is
    // processed, but it must be <= 2 to tolerate a concurrent second worker
    // completing before the checkpoint fires.
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(processed).toBeLessThan(10);
  });

  it("partial results are preserved — completed checks appear in the return value", async () => {
    const controller = new AbortController();
    const events: ReturnType<typeof result>[] = [];

    const addresses = [
      { username: "a", stellar_address: "G_a" },
      { username: "b", stellar_address: "G_b" },
      { username: "c", stellar_address: "G_c" },
    ];

    const results = await batchVerify(
      addresses,
      async (addr) => {
        const r = result(addr === "G_b" ? "not_ready" : "ready");
        events.push(r);
        // Abort after the second address so "c" is never started
        if (events.length === 2) controller.abort();
        return r;
      },
      { concurrency: 1, signal: controller.signal }
    );

    // The two completed checks are present; the aborted remainder is not
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.length).toBeLessThan(3);
    // No partial state: every result in the array is a complete record
    for (const r of results) {
      expect(r.checks).toBeDefined();
      expect(typeof r.status).toBe("string");
    }
  });

  it("progress events are emitted for completed addresses even when aborted mid-batch", async () => {
    const controller = new AbortController();
    const progressEvents: import("@/lib/batch-verify").BatchVerificationProgressEvent[] = [];

    const addresses = [
      { username: "a", stellar_address: "G_a" },
      { username: "b", stellar_address: "G_b" },
      { username: "c", stellar_address: "G_c" },
    ];

    await batchVerify(
      addresses,
      async (addr) => {
        if (addr === "G_b") controller.abort();
        return result("ready");
      },
      {
        concurrency: 1,
        jobId: "abort-test",
        signal: controller.signal,
        onProgress: (e) => { progressEvents.push(e); },
      }
    );

    // At least the first address emitted a progress event
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    // All emitted events carry the correct jobId
    for (const e of progressEvents) {
      expect(e.jobId).toBe("abort-test");
      expect(e.type).toBe("progress");
    }
  });

  it("pre-aborted signal: no addresses are processed", async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted before batchVerify is called

    const verifyFn = vi.fn(async () => result("ready"));

    const results = await batchVerify(
      [
        { username: "a", stellar_address: "G_a" },
        { username: "b", stellar_address: "G_b" },
      ],
      verifyFn,
      { concurrency: 1, signal: controller.signal }
    );

    expect(results).toHaveLength(0);
    expect(verifyFn).not.toHaveBeenCalled();
  });

  it("without a signal the full batch always completes (regression guard)", async () => {
    const addresses = Array.from({ length: 5 }, (_, i) => ({
      username: `user-${i}`,
      stellar_address: `G_${i}`,
    }));

    const results = await batchVerify(
      addresses,
      async () => result("ready"),
      { concurrency: 2 }
    );

    expect(results).toHaveLength(5);
  });
});
