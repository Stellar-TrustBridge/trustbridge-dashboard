import "server-only";

import { prisma } from "@/lib/prisma";

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
      const errorMsg = error instanceof Error ? error.message : String(error);
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