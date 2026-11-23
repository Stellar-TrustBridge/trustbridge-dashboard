import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSorobanOutbox,
  enqueueSorobanOutbox,
  getInMemoryOutboxMetrics,
  getSorobanOutboxEntry,
  isEntryParked,
  listPoisonedEntries,
  listSorobanOutbox,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  setSorobanOutboxSink,
  type SorobanOutboxEntry,
} from "./soroban-outbox";

// The Map and process-wide sink are separate module state: reset both for
// every case. Clearing the outbox alone does not unregister its delivery sink.
describe("in-memory Soroban outbox", () => {
  beforeEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useRealTimers();
  });

  it.each([undefined, null])("rejects a missing payload (%s) without storing it", async (payload) => {
    const sink = vi.fn();
    setSorobanOutboxSink(sink);

    await expect(enqueueSorobanOutbox(payload)).rejects.toThrow(
      "enqueueSorobanOutbox: payload is required",
    );

    expect(listSorobanOutbox()).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("persists a pending entry without a sink", async () => {
    const payload = { registrationId: "reg-1", githubUsername: "alice" };
    const entry = await enqueueSorobanOutbox(payload);

    expect(entry.id).toEqual(expect.any(String));
    expect(entry.id).not.toBe("");
    expect(entry).toMatchObject({
      payload,
      status: "PENDING",
      attempts: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entry.lastError).toBeUndefined();
    expect(getSorobanOutboxEntry(entry.id)).toBe(entry);
    expect(getSorobanOutboxEntry("missing")).toBeUndefined();
    expect(listSorobanOutbox()).toEqual([entry]);
  });

  it("returns the same pending entry for an idempotency key without replacing its payload", async () => {
    const first = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const sink = vi.fn();
    const duplicate = await enqueueSorobanOutbox({ registrationId: "replacement" }, {
      idempotencyKey: "mirror-1",
      sink,
    });

    expect(duplicate).toBe(first);
    expect(duplicate.id).toBe("mirror-1");
    expect(duplicate.payload).toEqual({ registrationId: "reg-1" });
    expect(duplicate.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(listSorobanOutbox()).toEqual([first]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("assigns distinct ids to equal payloads without an idempotency key", async () => {
    const payload = { registrationId: "reg-1" };
    const first = await enqueueSorobanOutbox(payload);
    const second = await enqueueSorobanOutbox(payload);

    expect(second.id).not.toBe(first.id);
    expect(listSorobanOutbox()).toEqual([first, second]);
  });

  it("lists entries in insertion order and keeps that order when retrying a failed entry", async () => {
    await expect(enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "z-first",
      sink: () => { throw new Error("unavailable"); },
    })).rejects.toThrow("unavailable");
    const second = await enqueueSorobanOutbox({ number: 2 }, { idempotencyKey: "a-second" });
    const first = await enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "z-first" });

    expect(listSorobanOutbox()).toEqual([first, second]);
    expect(first.status).toBe("PENDING");
    expect(first.attempts).toBe(1);
  });

  it("delivers a pending entry to the global sink and marks it sent after completion", async () => {
    const sink = vi.fn(async (entry: SorobanOutboxEntry) => {
      expect(entry.status).toBe("PENDING");
      expect(getSorobanOutboxEntry(entry.id)).toBe(entry);
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    });
    setSorobanOutboxSink(sink);

    const entry = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });
    const duplicate = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(entry);
    expect(entry.status).toBe("COMPLETED");
    expect(entry.attempts).toBe(0);
    expect(entry.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.updatedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(duplicate).toBe(entry);
    expect(listSorobanOutbox()).toEqual([entry]);
  });

  it("uses a per-enqueue sink override without changing the global sink", async () => {
    const globalSink = vi.fn();
    const overrideSink = vi.fn();
    setSorobanOutboxSink(globalSink);

    const overridden = await enqueueSorobanOutbox({ number: 1 }, { sink: overrideSink });
    const global = await enqueueSorobanOutbox({ number: 2 });

    expect(overrideSink).toHaveBeenCalledTimes(1);
    expect(overrideSink).toHaveBeenCalledWith(overridden);
    expect(globalSink).toHaveBeenCalledTimes(1);
    expect(globalSink).toHaveBeenCalledWith(global);
    expect(overridden.status).toBe("COMPLETED");
    expect(global.status).toBe("COMPLETED");
  });

  it("propagates async failures, counts retries, and clears the error on successful retry", async () => {
    const error = new Error("Soroban unavailable");
    const failingSink = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      throw error;
    });
    const options = { idempotencyKey: "retry-1", sink: failingSink };

    await expect(enqueueSorobanOutbox({ version: 1 }, options)).rejects.toBe(error);
    const failed = getSorobanOutboxEntry("retry-1");
    expect(failed).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "Soroban unavailable",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    await expect(enqueueSorobanOutbox({ version: 2 }, options)).rejects.toBe(error);
    expect(getSorobanOutboxEntry("retry-1")?.attempts).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const successfulSink = vi.fn();
    const retried = await enqueueSorobanOutbox({ version: 3 }, {
      idempotencyKey: "retry-1",
      sink: successfulSink,
    });

    expect(retried).not.toBe(failed);
    expect(retried).toMatchObject({
      id: "retry-1",
      payload: { version: 3 },
      status: "COMPLETED",
      attempts: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    expect(retried.lastError).toBeUndefined();
    expect(successfulSink).toHaveBeenCalledTimes(1);
    expect(successfulSink).toHaveBeenCalledWith(retried);
    expect(listSorobanOutbox()).toEqual([retried]);
  });

  it("records and rethrows non-Error synchronous sink failures", async () => {
    await expect(enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "sync-failure",
      sink: () => { throw "delivery failed"; },
    })).rejects.toBe("delivery failed");

    expect(getSorobanOutboxEntry("sync-failure")).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "delivery failed",
    });
  });

  it("deduplicates concurrent enqueues while delivery is still pending", async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const sink = vi.fn(() => delivery);
    const firstPromise = enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "concurrent",
      sink,
    });
    const duplicates = await Promise.all([
      enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "concurrent", sink }),
      enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "concurrent", sink }),
    ]);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(listSorobanOutbox()).toHaveLength(1);
    expect(duplicates[0]).toBe(duplicates[1]);
    expect(duplicates[0].status).toBe("PENDING");

    finishDelivery();
    const first = await firstPromise;
    expect(first).toBe(duplicates[0]);
    expect(first.status).toBe("COMPLETED");
    expect(listSorobanOutbox()).toEqual([first]);
  });

  it("clears all entries and allows the same key to be enqueued again", async () => {
    const first = await enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "reusable" });
    await enqueueSorobanOutbox({ number: 2 });

    clearSorobanOutbox();

    expect(listSorobanOutbox()).toEqual([]);
    expect(getSorobanOutboxEntry(first.id)).toBeUndefined();
    const fresh = await enqueueSorobanOutbox({ number: 3 }, { idempotencyKey: "reusable" });
    expect(fresh).not.toBe(first);
    expect(fresh.payload).toEqual({ number: 3 });
    expect(listSorobanOutbox()).toEqual([fresh]);
  });

  it("unregisters a global sink explicitly", async () => {
    const sink = vi.fn();
    setSorobanOutboxSink(sink);
    setSorobanOutboxSink(undefined);

    const entry = await enqueueSorobanOutbox({ number: 1 });

    expect(sink).not.toHaveBeenCalled();
    expect(entry.status).toBe("PENDING");
  });

  it("stores a large JSON payload and deduplicates it by its explicit key", async () => {
    const payload = JSON.parse(JSON.stringify({ data: "x".repeat(1024 * 1024) }));
    const entry = await enqueueSorobanOutbox(payload, { idempotencyKey: "large-payload" });
    const duplicate = await enqueueSorobanOutbox(payload, { idempotencyKey: "large-payload" });

    expect(entry.payload).toBe(payload);
    expect(entry.id).toBe("large-payload");
    expect(duplicate).toBe(entry);
    expect(listSorobanOutbox()).toEqual([entry]);
  });
});

// ── Retry budget and poison-message parking ──────────────────────────────────

describe("retry budget and poison-message park", () => {
  beforeEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useRealTimers();
  });

  it("OUTBOX_DEFAULT_MAX_ATTEMPTS is 5", () => {
    expect(OUTBOX_DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it("new entries carry the default maxAttempts budget", async () => {
    const entry = await enqueueSorobanOutbox({ registrationId: "reg-budget-1" });
    expect(entry.maxAttempts).toBe(OUTBOX_DEFAULT_MAX_ATTEMPTS);
  });

  it("new entries accept a custom maxAttempts budget", async () => {
    const entry = await enqueueSorobanOutbox(
      { registrationId: "reg-budget-2" },
      { idempotencyKey: "budget-custom", maxAttempts: 2 }
    );
    expect(entry.maxAttempts).toBe(2);
  });

  it("isEntryParked returns false for a pending entry", async () => {
    const entry = await enqueueSorobanOutbox({ registrationId: "reg-park-1" });
    expect(isEntryParked(entry)).toBe(false);
  });

  it("isEntryParked returns false for a FAILED entry within budget", async () => {
    const failSink = vi.fn(() => { throw new Error("fail"); });
    // budget=2, first failure uses attempts=1, still < maxAttempts=2
    await expect(
      enqueueSorobanOutbox({ registrationId: "reg-park-2" }, {
        idempotencyKey: "within-budget",
        sink: failSink,
        maxAttempts: 2,
      })
    ).rejects.toThrow();

    const entry = getSorobanOutboxEntry("within-budget")!;
    expect(entry.attempts).toBe(1);
    expect(entry.maxAttempts).toBe(2);
    expect(isEntryParked(entry)).toBe(false);
  });

  it("isEntryParked returns true once attempts reach maxAttempts", async () => {
    const failSink = vi.fn(() => { throw new Error("poison"); });

    // Exhaust a budget of 1 in one shot.
    await expect(
      enqueueSorobanOutbox({ registrationId: "reg-poison" }, {
        idempotencyKey: "poison-key",
        sink: failSink,
        maxAttempts: 1,
      })
    ).rejects.toThrow("poison");

    const parked = getSorobanOutboxEntry("poison-key")!;
    expect(parked.attempts).toBe(1);
    expect(parked.maxAttempts).toBe(1);
    expect(isEntryParked(parked)).toBe(true);
  });

  it("re-enqueue of a parked entry returns the parked entry without retrying", async () => {
    const failSink = vi.fn(() => { throw new Error("poison"); });
    const opts = { idempotencyKey: "poison-park", sink: failSink, maxAttempts: 1 };

    // First attempt — exhausts the budget.
    await expect(enqueueSorobanOutbox({ v: 1 }, opts)).rejects.toThrow("poison");

    const parked = getSorobanOutboxEntry("poison-park")!;
    expect(isEntryParked(parked)).toBe(true);

    // Second call — should return the parked entry untouched, not retry.
    const secondSink = vi.fn();
    const returned = await enqueueSorobanOutbox(
      { v: 2 },
      { idempotencyKey: "poison-park", sink: secondSink }
    );

    expect(returned).toBe(parked);
    expect(returned.attempts).toBe(1); // unchanged
    expect(secondSink).not.toHaveBeenCalled();
    expect(failSink).toHaveBeenCalledTimes(1);
  });

  it("listPoisonedEntries returns only budget-exhausted FAILED entries", async () => {
    const failSink = vi.fn(() => { throw new Error("poison"); });

    // Poison entry (budget=1 → parked after first failure).
    await expect(
      enqueueSorobanOutbox({ id: 1 }, { idempotencyKey: "dlq-poison", sink: failSink, maxAttempts: 1 })
    ).rejects.toThrow();

    // Within-budget failed entry (budget=3 → 1 failure, not yet parked).
    await expect(
      enqueueSorobanOutbox({ id: 2 }, { idempotencyKey: "dlq-within", sink: failSink, maxAttempts: 3 })
    ).rejects.toThrow();

    // Healthy pending entry.
    await enqueueSorobanOutbox({ id: 3 }, { idempotencyKey: "dlq-healthy" });

    const poisoned = listPoisonedEntries();
    expect(poisoned).toHaveLength(1);
    expect(poisoned[0].id).toBe("dlq-poison");
  });
});

// ── DLQ metrics ──────────────────────────────────────────────────────────────

describe("in-memory DLQ metrics", () => {
  beforeEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
  });

  afterEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
  });

  it("reports zeros on an empty outbox", () => {
    expect(getInMemoryOutboxMetrics()).toEqual({
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
      parked: 0,
    });
  });

  it("counts pending, completed, failed, and parked entries correctly", async () => {
    const failSink = vi.fn(() => { throw new Error("fail"); });
    const successSink = vi.fn();

    // 1 pending (no sink)
    await enqueueSorobanOutbox({ n: 1 }, { idempotencyKey: "m-pending" });

    // 1 completed
    await enqueueSorobanOutbox({ n: 2 }, { idempotencyKey: "m-ok", sink: successSink });

    // 1 failed within budget (maxAttempts=5, attempts=1)
    await expect(
      enqueueSorobanOutbox({ n: 3 }, { idempotencyKey: "m-fail", sink: failSink, maxAttempts: 5 })
    ).rejects.toThrow();

    // 1 parked (budget=1 exhausted)
    await expect(
      enqueueSorobanOutbox({ n: 4 }, { idempotencyKey: "m-parked", sink: failSink, maxAttempts: 1 })
    ).rejects.toThrow();

    const metrics = getInMemoryOutboxMetrics();
    expect(metrics.total).toBe(4);
    expect(metrics.pending).toBe(1);
    expect(metrics.completed).toBe(1);
    expect(metrics.failed).toBe(2);   // both "m-fail" and "m-parked" are FAILED
    expect(metrics.parked).toBe(1);    // only "m-parked" is budget-exhausted
  });

  it("parked count decreases after a manual clear (operator reset)", async () => {
    const failSink = vi.fn(() => { throw new Error("fail"); });
    await expect(
      enqueueSorobanOutbox({ n: 1 }, { idempotencyKey: "reset-parked", sink: failSink, maxAttempts: 1 })
    ).rejects.toThrow();

    expect(getInMemoryOutboxMetrics().parked).toBe(1);
    clearSorobanOutbox();
    expect(getInMemoryOutboxMetrics().parked).toBe(0);
  });

  it("happy-path delivery increments completed and leaves parked at zero", async () => {
    const successSink = vi.fn();
    await enqueueSorobanOutbox({ n: 1 }, { sink: successSink });
    await enqueueSorobanOutbox({ n: 2 }, { sink: successSink });

    const metrics = getInMemoryOutboxMetrics();
    expect(metrics.completed).toBe(2);
    expect(metrics.parked).toBe(0);
    expect(metrics.failed).toBe(0);
  });
});
