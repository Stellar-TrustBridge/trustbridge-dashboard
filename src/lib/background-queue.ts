import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { redactString } from "@/lib/sentry";

/**
 * Upper bound on a stored job error string (issue #200). A stack trace or a
 * dumped payload can be arbitrarily large; cap it so the dead-letter queue
 * can't bloat the row or the DLQ API response.
 */
export const MAX_ERROR_LENGTH = 2000;

/**
 * Normalise an error before it is persisted on a failed job:
 *  - run it through the Sentry redactor so a contributor address / token /
 *    email in the message never lands in the DLQ
 *  - cap the length
 */
export function sanitizeJobError(raw: string): string {
  const redacted = redactString(raw);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…[truncated]`
    : redacted;
}

export type JobType = "recheck.batch" | "recheck.single";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface Job {
  id: string;
  type: JobType;
  data: Record<string, unknown>;
  status: JobStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: Record<string, unknown>;
  ownerId?: string;
}

interface QueueMetrics {
  totalJobs: number;
  pendingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  averageProcessingTimeMs: number;
}

class BackgroundQueue {
  private queue: string[] = [];
  private processingCount = 0;
  private maxConcurrentJobs = 2;
  private jobHandlers: Map<JobType, (job: Job) => Promise<void>> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private workerStarted = false;

  private shouldAutoStartWorker(): boolean {
    return (
      process.env.NODE_ENV !== "production" &&
      process.env.NODE_ENV !== "test" &&
      process.env.VITEST !== "true"
    );
  }

  constructor() {
    if (this.shouldAutoStartWorker()) {
      this.startWorker();
    }
  }

  registerHandler(
    type: JobType,
    handler: (job: Job) => Promise<void>
  ): void {
    this.jobHandlers.set(type, handler);
    if (!this.workerStarted && this.shouldAutoStartWorker()) {
      this.startWorker();
    }
  }

  async enqueue(
    type: JobType,
    data: Record<string, unknown>,
    ownerId?: string
  ): Promise<string> {
    const record = await prisma.queueJob.create({
      data: {
        type,
        status: "pending",
        data: data as never,
        ownerId: ownerId ?? null,
      },
    });

    this.queue.push(record.id);
    return record.id;
  }

  private toJob(record: {
    id: string;
    type: string;
    data: unknown;
    status: string;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    error: string | null;
    result: unknown;
    ownerId: string | null;
  }): Job {
    return {
      id: record.id,
      type: record.type as JobType,
      data: (record.data as Record<string, unknown>) ?? {},
      status: record.status as JobStatus,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      error: record.error ?? undefined,
      result: (record.result as Record<string, unknown>) ?? undefined,
      ownerId: record.ownerId ?? undefined,
    };
  }

  async getJob(id: string): Promise<Job | undefined> {
    const record = await prisma.queueJob.findUnique({ where: { id } });
    if (!record) return undefined;
    return this.toJob(record);
  }

  /**
   * Dead-letter queue: the most recent failed jobs (issue #200).
   * Scoped to the caller's own jobs plus ownerless jobs, mirroring the
   * per-job endpoint's visibility rule.
   */
  async getFailedJobs(
    options: { limit?: number; ownerId?: string } = {},
  ): Promise<Job[]> {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 200);
    const records = await prisma.queueJob.findMany({
      where: {
        status: "failed",
        ...(options.ownerId
          ? { OR: [{ ownerId: options.ownerId }, { ownerId: null }] }
          : {}),
      },
      orderBy: { completedAt: "desc" },
      take: limit,
    });
    return records.map((record) => this.toJob(record));
  }

  /**
   * Re-queue a failed job (issue #200). Returns the updated job, or null when
   * the job does not exist, is not in the `failed` state, or belongs to a
   * different owner. Retry count is tracked on `data.__retries` so the UI can
   * show it and a future policy can cap it.
   */
  async retryJob(
    jobId: string,
    options: { ownerId?: string } = {},
  ): Promise<Job | null> {
    const record = await prisma.queueJob.findUnique({ where: { id: jobId } });
    if (!record || record.status !== "failed") return null;
    if (
      options.ownerId &&
      record.ownerId &&
      record.ownerId !== options.ownerId
    ) {
      return null;
    }

    const prevData = (record.data as Record<string, unknown>) ?? {};
    const retries =
      typeof prevData.__retries === "number" ? prevData.__retries : 0;

    const updated = await prisma.queueJob.update({
      where: { id: jobId },
      data: {
        status: "pending",
        error: null,
        result: Prisma.DbNull,
        startedAt: null,
        completedAt: null,
        data: { ...prevData, __retries: retries + 1 } as never,
      },
    });

    if (!this.queue.includes(jobId)) this.queue.push(jobId);
    if (!this.workerStarted && this.shouldAutoStartWorker()) {
      void this.startWorker();
    }

    return this.toJob(updated);
  }

  async getMetrics(): Promise<QueueMetrics> {
    const [totalJobs, pendingCount, processingCount, completedCount, failedCount] =
      await Promise.all([
        prisma.queueJob.count(),
        prisma.queueJob.count({ where: { status: "pending" } }),
        prisma.queueJob.count({ where: { status: "processing" } }),
        prisma.queueJob.count({ where: { status: "completed" } }),
        prisma.queueJob.count({ where: { status: "failed" } }),
      ]);

    // Calculate average processing time from recent completed jobs
    const recentJobs = await prisma.queueJob.findMany({
      where: {
        status: { in: ["completed", "failed"] },
        startedAt: { not: null },
        completedAt: { not: null },
      },
      orderBy: { completedAt: "desc" },
      take: 50,
      select: { startedAt: true, completedAt: true },
    });

    const averageProcessingTimeMs =
      recentJobs.length > 0
        ? recentJobs.reduce((sum, j) => {
            const ms = j.completedAt!.getTime() - j.startedAt!.getTime();
            return sum + ms;
          }, 0) / recentJobs.length
        : 0;

    return {
      totalJobs,
      pendingCount,
      processingCount,
      completedCount,
      failedCount,
      averageProcessingTimeMs,
    };
  }

  async getWorkerHealthMetrics(): Promise<{
    depth: number;
    failedCount: number;
    oldestPendingJobCreatedAt: string | null;
    isServerlessInMemoryWarning: boolean;
  }> {
    const [depth, failedCount, oldestPending] = await Promise.all([
      prisma.queueJob.count({ where: { status: "pending" } }),
      prisma.queueJob.count({ where: { status: "failed" } }),
      prisma.queueJob.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

    return {
      depth,
      failedCount,
      oldestPendingJobCreatedAt: oldestPending?.createdAt.toISOString() ?? null,
      isServerlessInMemoryWarning: true,
    };
  }

  private async startWorker(): Promise<void> {
    if (this.workerStarted) return;
    this.workerStarted = true;

    while (true) {
      try {
        if (
          this.processingCount < this.maxConcurrentJobs &&
          this.queue.length > 0
        ) {
          const jobId = this.queue.shift();
          if (jobId) {
            this.processingCount++;
            this.processJob(jobId).finally(() => {
              this.processingCount--;
            });
          }
        }

        // Also poll DB for pending jobs in case of serverless cold start
        if (this.queue.length === 0) {
          const pendingJobs = await prisma.queueJob.findMany({
            where: { status: "pending" },
            orderBy: { createdAt: "asc" },
            take: this.maxConcurrentJobs - this.processingCount,
            select: { id: true },
          });
          for (const j of pendingJobs) {
            if (!this.queue.includes(j.id)) {
              this.queue.push(j.id);
            }
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error("Queue worker error:", error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async processJob(jobId: string): Promise<void> {
    const record = await prisma.queueJob.findUnique({ where: { id: jobId } });
    if (!record || record.status !== "pending") return;

    await prisma.queueJob.update({
      where: { id: jobId },
      data: { status: "processing", startedAt: new Date() },
    });

    const job: Job = {
      id: record.id,
      type: record.type as JobType,
      data: (record.data as Record<string, unknown>) ?? {},
      status: "processing",
      createdAt: record.createdAt,
      startedAt: new Date(),
      ownerId: record.ownerId ?? undefined,
    };

    try {
      const handler = this.jobHandlers.get(job.type);
      if (!handler) {
        throw new Error("No handler registered for job type: " + job.type);
      }

      await handler(job);

      await prisma.queueJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          completedAt: new Date(),
          result: job.result as never,
        },
      });
    } catch (error) {
      const errorMsg = sanitizeJobError(
        error instanceof Error ? error.message : String(error),
      );
      await prisma.queueJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      console.error("Job " + jobId + " failed:", errorMsg);
    }
  }
}

export const backgroundQueue = new BackgroundQueue();