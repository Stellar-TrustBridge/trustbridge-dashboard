import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sorobanOutbox: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordAuditLog } from "@/lib/audit";
import {
  listSorobanOutboxDeadLetters,
  processSorobanOutbox,
  replayFailedSorobanOutboxEntry,
  getSorobanOutboxMetrics,
  computeOutboxRetryDelayMs,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_FACTOR,
  OUTBOX_RETRY_CEILING_MS,
} from "./soroban-outbox-worker";
import {
  enqueueSorobanOutbox,
  setSorobanOutboxSink,
  clearSorobanOutbox,
  getSorobanOutboxEntry,
  listSorobanOutbox,
} from "./soroban-outbox";

describe("Soroban Outbox Worker (Issue #199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.sorobanOutbox.updateMany).mockResolvedValue({ count: 1 });
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  afterEach(() => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  it("processes pending outbox records and marks them completed on success", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user1", registrationId: "reg-1" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: true,
      txHash: "0xhash",
      errors: [],
    });

    const result = await processSorobanOutbox();

    expect(result.processedCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("updates attempts with exponential backoff on failure and marks FAILED when max attempts exceeded", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-2",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user2", registrationId: "reg-2" },
        status: "PENDING",
        attempts: 4,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      errors: ["RPC Timeout"],
    });

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-2" },
      data: expect.objectContaining({ status: "FAILED", attempts: 5 }),
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "soroban_outbox_exhausted",
        targetId: "outbox-2",
      })
    );
  });

  it("lists only failed outbox metadata for the requested maintainer org", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-failed-1",
        action: "register",
        attempts: 5,
        lastError: "RPC timeout",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const items = await listSorobanOutboxDeadLetters("org-1", 20);

    expect(prisma.sorobanOutbox.findMany).toHaveBeenCalledWith({
      where: { maintainerOrgId: "org-1", status: "FAILED" },
      select: {
        id: true,
        action: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    expect(items[0]).not.toHaveProperty("payload");
  });

  it("atomically resets a failed item for replay within the requested org", async () => {
    vi.mocked(prisma.sorobanOutbox.findFirst).mockResolvedValueOnce({
      id: "outbox-failed-1",
      action: "register",
      attempts: 5,
    } as any);

    const item = await replayFailedSorobanOutboxEntry(
      "outbox-failed-1",
      "org-1"
    );

    expect(item).toEqual({
      id: "outbox-failed-1",
      action: "register",
      previousAttempts: 5,
    });
    expect(prisma.sorobanOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-failed-1",
        maintainerOrgId: "org-1",
        status: "FAILED",
      },
      data: expect.objectContaining({
        status: "PENDING",
        attempts: 0,
        lastError: null,
      }),
    });
  });

  it("does not replay items that are missing, non-failed, or outside the org", async () => {
    vi.mocked(prisma.sorobanOutbox.findFirst).mockResolvedValueOnce(null);

    await expect(
      replayFailedSorobanOutboxEntry("outbox-other-org", "org-1")
    ).resolves.toBeNull();
    expect(prisma.sorobanOutbox.updateMany).not.toHaveBeenCalled();
  });
});

describe("Unified Outbox Adapter (Issue #488)", () => {
  it("routes production enqueue through Prisma create", async () => {
    vi.mocked(prisma.sorobanOutbox.create).mockResolvedValueOnce({
      id: "outbox-test-1",
      maintainerOrgId: "org-1",
      action: "register",
      payload: { stellarAddress: "G1", githubUsername: "u1", registrationId: "r1" },
      status: "PENDING",
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await enqueueSorobanOutbox(
      {
        stellarAddress: "G1",
        githubUsername: "u1",
        registrationId: "r1",
      },
      {
        maintainerOrgId: "org-1",
        action: "register",
      }
    );

    expect(prisma.sorobanOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        maintainerOrgId: "org-1",
        action: "register",
        status: "PENDING",
      }),
    });
    expect(result.id).toBe("outbox-test-1");
  });

  it("runs in-memory via test sink when setSorobanOutboxSink is configured", async () => {
    // Capture the observed status eagerly: the sink receives the live entry
    // object, which the adapter marks COMPLETED after delivery resolves.
    const observedStatuses: unknown[] = [];
    const sinkMock = vi.fn(async (entry: { status: unknown }) => {
      observedStatuses.push(entry.status);
    });
    setSorobanOutboxSink(sinkMock);

    const payload = { stellarAddress: "G2", githubUsername: "u2", registrationId: "r2" };
    const entry = await enqueueSorobanOutbox(payload, { idempotencyKey: "idem-1" });

    expect(sinkMock).toHaveBeenCalledTimes(1);
    // The sink observed the entry as-enqueued (PENDING)...
    expect(observedStatuses).toEqual(["PENDING"]);
    // ...while the stored entry advanced to COMPLETED after delivery.
    expect(entry.status).toBe("COMPLETED");
    expect(getSorobanOutboxEntry("idem-1")?.status).toBe("COMPLETED");
  });

  it("marks rows failed and increments attempts when sink callback throws", async () => {
    const sinkError = new Error("Sink delivery failure");
    setSorobanOutboxSink(vi.fn().mockRejectedValue(sinkError));

    await expect(
      enqueueSorobanOutbox({ test: 123 }, { idempotencyKey: "fail-1" })
    ).rejects.toThrow("Sink delivery failure");

    const entry = getSorobanOutboxEntry("fail-1");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("FAILED");
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastError).toBe("Sink delivery failure");
  });

  it("clears in-memory outbox state without leaving stale Map entries across tests", () => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
    expect(listSorobanOutbox()).toHaveLength(0);
  });
});


describe("Retry budget and poison-message park (processSorobanOutbox)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.sorobanOutbox.updateMany).mockResolvedValue({ count: 1 });
  });

  it("parks an entry as FAILED and fires audit event when maxAttempts is exhausted on first attempt", async () => {
    // attempts=0 → nextAttempts=1 >= maxAttempts=1: immediate park
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "poison-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "GXXX", githubUsername: "alice", registrationId: "r1" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 1,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      error: { message: "RPC down" },
    });

    const result = await processSorobanOutbox({ maxAttempts: 1 });

    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "poison-1" },
        data: expect.objectContaining({ status: "FAILED", attempts: 1 }),
      })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "soroban_outbox_exhausted", targetId: "poison-1" })
    );
  });

  it("reschedules with PENDING (not FAILED) when attempts < maxAttempts", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "retry-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "GYYY", githubUsername: "bob", registrationId: "r2" },
        status: "PENDING",
        attempts: 1,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      error: { message: "transient" },
    });

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    expect(result.failedCount).toBe(0); // not yet parked
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "retry-1" },
        data: expect.objectContaining({ status: "PENDING", attempts: 2 }),
      })
    );
    // No park audit event for a mid-budget retry.
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("throws from mirrorRegistrationToSoroban are caught and treated as failures", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "throw-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "GZZZ", githubUsername: "carol", registrationId: "r3" },
        status: "PENDING",
        attempts: 4,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockRejectedValueOnce(
      new Error("network timeout")
    );

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    // attempts 4+1=5 >= maxAttempts=5 → parked
    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "soroban_outbox_exhausted" })
    );
  });
});

describe("DLQ metrics (getSorobanOutboxMetrics)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all-zero metrics when count resolves to zero for every status", async () => {
    vi.mocked(prisma.sorobanOutbox.count).mockResolvedValue(0);

    const metrics = await getSorobanOutboxMetrics("org-1");
    expect(metrics).toEqual({
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    });
  });

  it("surfaces correct counts per status from Prisma", async () => {
    // count calls: total, pending, processing, completed, failed
    vi.mocked(prisma.sorobanOutbox.count)
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(3)  // pending
      .mockResolvedValueOnce(1)  // processing
      .mockResolvedValueOnce(5)  // completed
      .mockResolvedValueOnce(1); // failed (parked poison message)

    const metrics = await getSorobanOutboxMetrics("org-1");
    expect(metrics).toEqual({
      total: 10,
      pending: 3,
      processing: 1,
      completed: 5,
      failed: 1,
    });
  });

  it("omits maintainerOrgId scope when not provided (global metrics)", async () => {
    vi.mocked(prisma.sorobanOutbox.count).mockResolvedValue(0);
    await getSorobanOutboxMetrics();

    // All count calls should NOT include maintainerOrgId in the where clause.
    for (const call of vi.mocked(prisma.sorobanOutbox.count).mock.calls) {
      const whereArg = (call[0] as any)?.where;
      expect(whereArg).not.toHaveProperty("maintainerOrgId");
    }
  });
});

describe("computeOutboxRetryDelayMs — ceiling and jitter", () => {
  it("exports the schedule constants", () => {
    expect(OUTBOX_RETRY_BASE_MS).toBe(2_000);
    expect(OUTBOX_RETRY_FACTOR).toBe(4);
    expect(OUTBOX_RETRY_CEILING_MS).toBe(5 * 60 * 1_000);
  });

  it("never exceeds the ceiling across many injected random values", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = computeOutboxRetryDelayMs(attempt, () => r);
        expect(delay).toBeLessThanOrEqual(OUTBOX_RETRY_CEILING_MS);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("random=0 always returns 0 (full-jitter lower bound)", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(computeOutboxRetryDelayMs(attempt, () => 0)).toBe(0);
    }
  });

  it("grows toward the ceiling as attempts increase (high rng)", () => {
    const earlyDelay = computeOutboxRetryDelayMs(1, () => 0.999);
    const lateDelay = computeOutboxRetryDelayMs(5, () => 0.999);
    // Later attempts have a larger cap, so the high-rng sample grows.
    expect(lateDelay).toBeGreaterThanOrEqual(earlyDelay);
  });
});
