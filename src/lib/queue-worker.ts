import "server-only";

import { backgroundQueue, type Job } from "@/lib/background-queue";
import {
  getContributors,
  refreshAllContributors,
  refreshContributor,
} from "@/lib/registrations";

// Register batch recheck handler
backgroundQueue.registerHandler("recheck.batch", async (job: Job) => {
  const startTime = Date.now();

  const refreshed = await refreshAllContributors();
  const { contributors } = await getContributors();

  job.result = {
    refreshed: refreshed.refreshed,
    changed: refreshed.changed,
    contributorCount: contributors.length,
    errorCount: refreshed.errors.length,
    durationMs: Date.now() - startTime,
  };
});

// Register single contributor recheck handler
backgroundQueue.registerHandler("recheck.single", async (job: Job) => {
  const startTime = Date.now();
  const { contributorId } = job.data;

  if (!contributorId || typeof contributorId !== "string") {
    throw new Error("contributorId is required and must be a string");
  }

  const result = await refreshContributor(contributorId);

  if (!result) {
    throw new Error(`Contributor ${contributorId} not found`);
  }

  const { contributor } = result;

  job.result = {
    contributorId,
    githubUsername: contributor.githubUsername,
    readiness: contributor.readiness,
    verified: contributor.verified,
    durationMs: Date.now() - startTime,
  };
});

/**
 * Runs the durable background worker until termination signal is received.
 */
export async function runWorker(): Promise<void> {
  console.log("Starting TrustBridge durable background worker...");

  const handleShutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down worker gracefully...`);
    backgroundQueue.stop();
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  await backgroundQueue.startWorkerLoop();
}

export { backgroundQueue };
