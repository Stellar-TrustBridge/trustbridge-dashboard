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

export interface QueueMetrics {
  totalJobs: number;
  pendingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  averageProcessingTimeMs: number;
}

export type JobHandler = (job: Job) => Promise<void>;

export class BackgroundQueue {
  private jobHandlers: Map<JobType, JobHandler> = new Map();
  private isRunning = false;
  private stopRequested = false;
  private pollIntervalMs: number;
  private maxConcurrency: number;

  constructor(options?: { pollIntervalMs?: number; maxConcurrency?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrency = options?.maxConcurrency ?? 2;
  }

  /**
   * Registers a worker handler for a specific job type.
   */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.jobHandlers.set(type, handler);
  }

  /**
   * Enqueues a job durably to the database (QueueJob table).
   */
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

    return record.id;
  }

  /**
   * Retrieves a job by ID from the database.
   */
  async getJob(id: string): Promise<Job | undefined> {
    const record = await prisma.queueJob.findUnique({ where: { id } });
    if (!record) return undefined;

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

  /**
   * Retrieves current metrics across all jobs in the database.
   */
  async getMetrics(): Promise<QueueMetrics> {
    const [totalJobs, pendingCount, processingCount, completedCount, failedCount] =
      await Promise.all([
        prisma.queueJob.count(),
        prisma.queueJob.count({ where: { status: "pending" } }),
        prisma.queueJob.count({ where: { status: "processing" } }),
        prisma.queueJob.count({ where: { status: "completed" } }),
        prisma.queueJob.count({ where: { status: "failed" } }),
      ]);

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

  /**
   * Atomically claims the next pending job from PostgreSQL to prevent double processing.
   */
  async claimNextPendingJob(): Promise<Job | null> {
    // Find oldest pending job
    const candidate = await prisma.queueJob.findFirst({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (!candidate) return null;

    // Atomically claim by updating status from pending -> processing
    const now = new Date();
    const updated = await prisma.queueJob.updateMany({
      where: {
        id: candidate.id,
        status: "pending",
      },
      data: {
        status: "processing",
        startedAt: now,
      },
    });

    if (updated.count === 0) {
      // Race condition: another worker claimed it first
      return null;
    }

    const claimedRecord = await prisma.queueJob.findUnique({
      where: { id: candidate.id },
    });

    if (!claimedRecord) return null;

    return {
      id: claimedRecord.id,
      type: claimedRecord.type as JobType,
      data: (claimedRecord.data as Record<string, unknown>) ?? {},
      status: "processing",
      createdAt: claimedRecord.createdAt,
      startedAt: now,
      ownerId: claimedRecord.ownerId ?? undefined,
    };
  }

  /**
   * Processes a single claimed job.
   */
  async processJob(job: Job): Promise<void> {
    const handler = this.jobHandlers.get(job.type);

    if (!handler) {
      const errorMsg = `No handler registered for job type: ${job.type}`;
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      return;
    }

    try {
      await handler(job);

      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          result: (job.result as never) ?? null,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: errorMsg,
        },
      });
      console.error(`[QueueWorker] Job ${job.id} failed:`, errorMsg);
    }
  }

  /**
   * Runs the worker loop continuously until stop() is called.
   */
  async startWorkerLoop(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopRequested = false;

    console.log("[QueueWorker] Background worker loop started.");

    while (!this.stopRequested) {
      try {
        const job = await this.claimNextPendingJob();
        if (job) {
          await this.processJob(job);
        } else {
          // No pending jobs, sleep for poll interval
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (error) {
        console.error("[QueueWorker] Worker loop error:", error);
        await new Promise((resolve) => setTimeout(resolve, Math.max(this.pollIntervalMs, 3000)));
      }
    }

    this.isRunning = false;
    console.log("[QueueWorker] Background worker loop stopped.");
  }

  /**
   * Signals the worker loop to stop gracefully.
   */
  stop(): void {
    this.stopRequested = true;
  }
}

export const backgroundQueue = new BackgroundQueue();
