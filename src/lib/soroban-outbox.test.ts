import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimNextSorobanOutboxEntries,
  claimSorobanOutboxEntry,
  clearSorobanOutbox,
  completeSorobanOutboxClaim,
  drainSorobanOutboxWithLease,
  enqueueSorobanOutbox,
  failSorobanOutboxClaim,
  getSorobanOutboxEntry,
  listSorobanOutbox,
  MAX_OUTBOX_BATCH_SIZE,
  MAX_OUTBOX_LEASE_MS,
  MAX_OUTBOX_WORKER_ID_LENGTH,
  releaseSorobanOutboxClaim,
  resolveOutboxLeaseMs,
  setSorobanOutboxSink,
  SOROBAN_OUTBOX_REASON_CODES,
  SorobanOutboxError,
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

describe("Soroban outbox exactly-once delivery claims under concurrency (Issue #793)", () => {
  const originalLeaseEnv = process.env.SOROBAN_OUTBOX_LEASE_MS;

  beforeEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    delete process.env.SOROBAN_OUTBOX_LEASE_MS;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    if (originalLeaseEnv === undefined) {
      delete process.env.SOROBAN_OUTBOX_LEASE_MS;
    } else {
      process.env.SOROBAN_OUTBOX_LEASE_MS = originalLeaseEnv;
    }
    vi.useRealTimers();
  });

  it("guarantees exactly-once delivery across many concurrent workers draining a shared outbox", async () => {
    const totalEntries = 60;
    const workerCount = 12;

    for (let i = 0; i < totalEntries; i++) {
      await enqueueSorobanOutbox(
        { registrationId: `reg-${i}`, index: i },
        { idempotencyKey: `entry-${i}` },
      );
    }

    const deliveryCounts = new Map<string, number>();
    const sink = vi.fn(async (entry: SorobanOutboxEntry) => {
      // Yield across microtasks / event loop ticks to maximize interleaving.
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, (entry.id.length % 3) + 1));
      deliveryCounts.set(entry.id, (deliveryCounts.get(entry.id) ?? 0) + 1);
    });

    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, workerIndex) =>
        drainSorobanOutboxWithLease({
          workerId: `worker-${workerIndex}`,
          sink,
          batchSize: 10,
          leaseMs: 30_000,
        }),
      ),
    );

    const totalClaimed = results.reduce((sum, r) => sum + r.claimedCount, 0);
    const totalDelivered = results.reduce((sum, r) => sum + r.deliveredCount, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failedCount, 0);

    expect(totalClaimed).toBe(totalEntries);
    expect(totalDelivered).toBe(totalEntries);
    expect(totalFailed).toBe(0);
    expect(sink).toHaveBeenCalledTimes(totalEntries);
    expect(deliveryCounts.size).toBe(totalEntries);

    for (let i = 0; i < totalEntries; i++) {
      const id = `entry-${i}`;
      expect(deliveryCounts.get(id)).toBe(1);
      const stored = getSorobanOutboxEntry(id);
      expect(stored?.status).toBe("COMPLETED");
      expect(stored?.leaseOwner).toBeUndefined();
      expect(stored?.leaseToken).toBeUndefined();
      expect(stored?.leaseExpiresAt).toBeUndefined();
    }

    // Repeated invocations are idempotent: a follow-up drain claims nothing.
    const followUp = await drainSorobanOutboxWithLease({
      workerId: "worker-followup",
      sink,
      batchSize: 10,
    });
    expect(followUp).toMatchObject({
      claimedCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    });
    expect(sink).toHaveBeenCalledTimes(totalEntries);
  });

  it("allows only one concurrent worker to claim a single entry under contention", async () => {
    await enqueueSorobanOutbox({ registrationId: "hot-1" }, { idempotencyKey: "hot-entry" });

    const attempts = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        Promise.resolve().then(() =>
          claimSorobanOutboxEntry("hot-entry", {
            workerId: `contender-${i}`,
            leaseMs: 15_000,
          }),
        ),
      ),
    );

    const winners = attempts.filter((r) => r.claimed);
    const losers = attempts.filter((r) => !r.claimed);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(24);
    for (const loser of losers) {
      if (!loser.claimed) {
        expect(loser.reasonCode).toBe(SOROBAN_OUTBOX_REASON_CODES.ALREADY_CLAIMED);
      }
    }
  });

  it("reclaims an expired lease and rejects stale fencing tokens from stalled workers", async () => {
    await enqueueSorobanOutbox({ registrationId: "reg-lease" }, { idempotencyKey: "lease-1" });

    const firstClaim = claimSorobanOutboxEntry("lease-1", {
      workerId: "worker-stalled",
      leaseMs: 5_000,
    });
    expect(firstClaim.claimed).toBe(true);
    if (!firstClaim.claimed) throw new Error("expected initial claim to succeed");
    expect(firstClaim.reclaimedExpiredLease).toBe(false);

    // Before expiry, a second worker is rejected.
    vi.setSystemTime(new Date("2026-01-01T00:00:04.999Z"));
    const earlyAttempt = claimSorobanOutboxEntry("lease-1", {
      workerId: "worker-fast",
      leaseMs: 5_000,
    });
    expect(earlyAttempt).toEqual({
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ALREADY_CLAIMED,
    });

    // At expiry, the second worker reclaims the entry with a new fencing token.
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    const reclaimed = claimSorobanOutboxEntry("lease-1", {
      workerId: "worker-fast",
      leaseMs: 10_000,
    });
    expect(reclaimed.claimed).toBe(true);
    if (!reclaimed.claimed) throw new Error("expected reclaim to succeed");
    expect(reclaimed.reclaimedExpiredLease).toBe(true);
    expect(reclaimed.leaseToken).not.toBe(firstClaim.leaseToken);
    expect(reclaimed.entry.leaseOwner).toBe("worker-fast");

    // Stalled worker wakes up and attempts to complete, fail, or release using its stale token.
    expect(completeSorobanOutboxClaim("lease-1", firstClaim.leaseToken)).toEqual({
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    });
    expect(
      failSorobanOutboxClaim("lease-1", firstClaim.leaseToken, new Error("late timeout")),
    ).toEqual({
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    });
    expect(releaseSorobanOutboxClaim("lease-1", firstClaim.leaseToken)).toEqual({
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    });

    // Active owner completes cleanly and prevents any further claims.
    const completed = completeSorobanOutboxClaim("lease-1", reclaimed.leaseToken);
    expect(completed.ok).toBe(true);
    expect(getSorobanOutboxEntry("lease-1")?.status).toBe("COMPLETED");
    expect(
      claimSorobanOutboxEntry("lease-1", { workerId: "worker-late" }),
    ).toEqual({
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ALREADY_COMPLETED,
    });
  });

  it("requeues transient failures with actionable errors and stops claiming after maxAttempts", async () => {
    await enqueueSorobanOutbox({ registrationId: "reg-flaky" }, { idempotencyKey: "flaky-1" });

    const failResult = await drainSorobanOutboxWithLease({
      workerId: "worker-1",
      maxAttempts: 2,
      sink: async () => {
        throw new Error("Soroban RPC 503 unavailable");
      },
    });
    expect(failResult).toMatchObject({
      claimedCount: 1,
      deliveredCount: 0,
      failedCount: 1,
    });

    const afterFirstFail = getSorobanOutboxEntry("flaky-1");
    expect(afterFirstFail).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "Soroban RPC 503 unavailable",
    });
    expect(afterFirstFail?.leaseToken).toBeUndefined();

    // Exhausting maxAttempts transitions the entry to terminal FAILED.
    const terminalFail = await drainSorobanOutboxWithLease({
      workerId: "worker-2",
      maxAttempts: 2,
      sink: async () => {
        throw new Error("Soroban RPC timeout");
      },
    });
    expect(terminalFail).toMatchObject({
      claimedCount: 1,
      deliveredCount: 0,
      failedCount: 1,
    });
    expect(getSorobanOutboxEntry("flaky-1")).toMatchObject({
      status: "FAILED",
      attempts: 2,
      lastError: "Soroban RPC timeout",
    });
    expect(
      claimSorobanOutboxEntry("flaky-1", { workerId: "worker-3" }),
    ).toEqual({
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.NOT_CLAIMABLE,
    });
  });

  it("releases leases cleanly on mid-flight cancel/pause without leaving partial PROCESSING state", async () => {
    await enqueueSorobanOutbox({ registrationId: "reg-a" }, { idempotencyKey: "cancel-a" });
    await enqueueSorobanOutbox({ registrationId: "reg-b" }, { idempotencyKey: "cancel-b" });

    const controller = new AbortController();
    const delivered: string[] = [];

    const firstDrain = await drainSorobanOutboxWithLease({
      workerId: "worker-pausing",
      batchSize: 2,
      signal: controller.signal,
      sink: async (entry) => {
        delivered.push(entry.id);
        // Pause/freeze mid-flight after delivering the first entry.
        controller.abort();
      },
    });

    expect(firstDrain).toMatchObject({
      claimedCount: 2,
      deliveredCount: 1,
      releasedCount: 1,
      failedCount: 0,
    });
    expect(getSorobanOutboxEntry("cancel-a")?.status).toBe("COMPLETED");
    expect(getSorobanOutboxEntry("cancel-b")).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });
    expect(getSorobanOutboxEntry("cancel-b")?.leaseOwner).toBeUndefined();
    expect(getSorobanOutboxEntry("cancel-b")?.leaseToken).toBeUndefined();

    // A resumed worker picks up only the released entry and delivers it exactly once.
    const resumedDrain = await drainSorobanOutboxWithLease({
      workerId: "worker-resumed",
      batchSize: 2,
      sink: async (entry) => {
        delivered.push(entry.id);
      },
    });
    expect(resumedDrain).toMatchObject({
      claimedCount: 1,
      deliveredCount: 1,
    });
    expect(delivered).toEqual(["cancel-a", "cancel-b"]);
  });

  it("rejects empty, oversized, or malformed claim inputs with stable documented reason codes", () => {
    expect(() =>
      claimSorobanOutboxEntry("any", { workerId: "   " }),
    ).toThrow(SorobanOutboxError);
    try {
      claimSorobanOutboxEntry("any", { workerId: "" });
    } catch (err) {
      expect(err).toBeInstanceOf(SorobanOutboxError);
      expect((err as SorobanOutboxError).code).toBe(
        SOROBAN_OUTBOX_REASON_CODES.INVALID_WORKER_ID,
      );
    }

    try {
      claimSorobanOutboxEntry("any", {
        workerId: "w".repeat(MAX_OUTBOX_WORKER_ID_LENGTH + 1),
      });
    } catch (err) {
      expect((err as SorobanOutboxError).code).toBe(
        SOROBAN_OUTBOX_REASON_CODES.INVALID_WORKER_ID,
      );
    }

    for (const badLease of [0, -50, Number.NaN, Number.POSITIVE_INFINITY, MAX_OUTBOX_LEASE_MS + 1]) {
      try {
        resolveOutboxLeaseMs(badLease);
        expect.unreachable("expected resolveOutboxLeaseMs to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SorobanOutboxError);
        expect((err as SorobanOutboxError).code).toBe(
          SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_MS,
        );
      }
    }

    process.env.SOROBAN_OUTBOX_LEASE_MS = "not-a-number";
    try {
      resolveOutboxLeaseMs();
      expect.unreachable("expected invalid env var to throw");
    } catch (err) {
      expect((err as SorobanOutboxError).code).toBe(
        SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_MS,
      );
    }
    delete process.env.SOROBAN_OUTBOX_LEASE_MS;

    try {
      completeSorobanOutboxClaim("any", "   ");
      expect.unreachable("expected invalid leaseToken to throw");
    } catch (err) {
      expect((err as SorobanOutboxError).code).toBe(
        SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_TOKEN,
      );
    }

    for (const badBatch of [0, -1, 1.5, MAX_OUTBOX_BATCH_SIZE + 1]) {
      try {
        claimNextSorobanOutboxEntries({ workerId: "w1", batchSize: badBatch });
        expect.unreachable("expected invalid batchSize to throw");
      } catch (err) {
        expect((err as SorobanOutboxError).code).toBe(
          SOROBAN_OUTBOX_REASON_CODES.INVALID_BATCH_SIZE,
        );
      }
    }

    expect(claimSorobanOutboxEntry("does-not-exist", { workerId: "w1" })).toEqual({
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND,
    });
  });
});
