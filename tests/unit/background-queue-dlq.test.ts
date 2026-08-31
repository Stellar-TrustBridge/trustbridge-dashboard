/**
 * Unit tests for the dead-letter-queue additions to BackgroundQueue (issue #200):
 * error size cap + PII redaction, getFailedJobs, retryJob.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    queueJob: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  MAX_ERROR_LENGTH,
  backgroundQueue,
  sanitizeJobError,
} from "@/lib/background-queue";

const findMany = vi.mocked(prisma.queueJob.findMany);
const findUnique = vi.mocked(prisma.queueJob.findUnique);
const update = vi.mocked(prisma.queueJob.update);

const SAMPLE_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sanitizeJobError", () => {
  it("redacts a Stellar address from the message", () => {
    const out = sanitizeJobError(`account ${SAMPLE_ADDRESS} not found`);
    expect(out).not.toContain(SAMPLE_ADDRESS);
    expect(out).toContain("redacted:stellar-address");
  });

  it("caps the length", () => {
    const out = sanitizeJobError("x".repeat(MAX_ERROR_LENGTH + 5000));
    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH + 20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves a short benign message untouched", () => {
    expect(sanitizeJobError("Horizon connection timeout")).toBe(
      "Horizon connection timeout",
    );
  });
});

describe("getFailedJobs", () => {
  it("queries only failed jobs, newest first, capped at 200", async () => {
    findMany.mockResolvedValue([] as never);
    await backgroundQueue.getFailedJobs({ limit: 9999 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "failed" },
        orderBy: { completedAt: "desc" },
        take: 200,
      }),
    );
  });

  it("scopes to the owner plus ownerless jobs", async () => {
    findMany.mockResolvedValue([] as never);
    await backgroundQueue.getFailedJobs({ ownerId: "user-1" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "failed",
          OR: [{ ownerId: "user-1" }, { ownerId: null }],
        },
      }),
    );
  });

  it("maps rows into the Job shape", async () => {
    findMany.mockResolvedValue([
      {
        id: "j1",
        type: "recheck.single",
        status: "failed",
        data: { __retries: 1 },
        result: null,
        error: "boom",
        ownerId: "user-1",
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ] as never);

    const jobs = await backgroundQueue.getFailedJobs();
    expect(jobs[0]).toMatchObject({ id: "j1", status: "failed", error: "boom" });
  });
});

describe("retryJob", () => {
  it("returns null when the job does not exist", async () => {
    findUnique.mockResolvedValue(null);
    expect(await backgroundQueue.retryJob("nope")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns null when the job is not in the failed state", async () => {
    findUnique.mockResolvedValue({ id: "j1", status: "completed" } as never);
    expect(await backgroundQueue.retryJob("j1")).toBeNull();
  });

  it("returns null when the job belongs to another owner", async () => {
    findUnique.mockResolvedValue({
      id: "j1",
      status: "failed",
      ownerId: "someone-else",
      data: {},
    } as never);
    expect(
      await backgroundQueue.retryJob("j1", { ownerId: "user-1" }),
    ).toBeNull();
  });

  it("resets a failed job to pending and bumps the retry count", async () => {
    findUnique.mockResolvedValue({
      id: "j1",
      type: "recheck.batch",
      status: "failed",
      ownerId: "user-1",
      data: { __retries: 2 },
      result: null,
      error: "boom",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    } as never);
    update.mockImplementation((async (args: { data: unknown }) => ({
      id: "j1",
      type: "recheck.batch",
      status: "pending",
      ownerId: "user-1",
      data: (args.data as { data: unknown }).data,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    })) as never);

    const job = await backgroundQueue.retryJob("j1", { ownerId: "user-1" });
    expect(job?.status).toBe("pending");

    const updateArg = update.mock.calls[0][0] as {
      data: { status: string; error: null; data: { __retries: number } };
    };
    expect(updateArg.data.status).toBe("pending");
    expect(updateArg.data.error).toBeNull();
    expect(updateArg.data.data.__retries).toBe(3);
  });
});
