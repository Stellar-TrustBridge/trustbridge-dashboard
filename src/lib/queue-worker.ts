import "server-only";

import { backgroundQueue, type Job } from "@/lib/background-queue";
import { createNotification } from "@/lib/notifications";
import {
  getContributors,
  refreshAllContributors,
  refreshContributor,
} from "@/lib/registrations";

backgroundQueue.registerHandler("recheck.batch", async (job: Job) => {
  const startTime = Date.now();

  try {
    const refreshed = await refreshAllContributors();
    const { contributors } = await getContributors();

    job.result = {
      refreshed: refreshed.refreshed,
      changed: refreshed.changed,
      contributorCount: contributors.length,
      errorCount: refreshed.errors.length,
      durationMs: Date.now() - startTime,
    };

    // Create notification for completed batch job
    await createNotification({
      userId: job.ownerId ?? null,
      type: "BATCH_JOB_COMPLETED",
      title: "Batch check completed",
      body: `Batch recheck finished: ${refreshed.refreshed} contributors checked (${refreshed.changed} status changes, ${refreshed.errors.length} errors).`,
      metadata: { jobId: job.id, ...job.result },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await createNotification({
      userId: job.ownerId ?? null,
      type: "BATCH_JOB_FAILED",
      title: "Batch check failed",
      body: `Batch recheck failed: ${errorMsg}`,
      metadata: { jobId: job.id, error: errorMsg },
    });
    throw error;
  }
});

backgroundQueue.registerHandler("recheck.single", async (job: Job) => {
  const startTime = Date.now();
  const { contributorId } = job.data;

  if (!contributorId || typeof contributorId !== "string") {
    throw new Error("contributorId is required and must be a string");
  }

  try {
    const result = await refreshContributor(contributorId);

    if (!result) {
      throw new Error("Contributor " + contributorId + " not found");
    }

    const { contributor } = result;

    job.result = {
      contributorId,
      githubUsername: contributor.githubUsername,
      readiness: contributor.readiness,
      verified: contributor.verified,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    throw error;
  }
});

export { backgroundQueue };