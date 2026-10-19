import "server-only";

import { backgroundQueue, type Job } from "@/lib/background-queue";
import { createNotification } from "@/lib/notifications";
import {
  getContributors,
  refreshAllContributors,
  refreshContributor,
} from "@/lib/registrations";

// Register batch recheck handler
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


// Register invite expiry reminder handler
backgroundQueue.registerHandler("invite.expiry_reminder", async (job: Job) => {
  const startTime = Date.now();

  try {
    const { countExpiringInvites, findExpiringInvites } = await import("@/lib/invite-helpers");
    const { sendEmailNotification, buildInviteExpiryReminderBody } = await import("@/lib/email");

    // Default to 48-hour threshold (configurable via job data)
    const thresholdHours =
      typeof job.data.thresholdHours === "number" ? job.data.thresholdHours : 48;
    const thresholdMs = thresholdHours * 60 * 60 * 1000;

    const [count, invites] = await Promise.all([
      countExpiringInvites(thresholdMs),
      findExpiringInvites(thresholdMs),
    ]);

    if (count === 0) {
      job.result = {
        expiringCount: 0,
        emailSent: false,
        durationMs: Date.now() - startTime,
        message: "No expiring invites found",
      };
      return;
    }

    const recipientEmail =
      process.env.INVITE_REMINDER_EMAIL ??
      process.env.DIGEST_EMAIL ??
      process.env.TREASURY_EXPORT_EMAIL;

    if (!recipientEmail) {
      throw new Error(
        "No recipient configured: set INVITE_REMINDER_EMAIL, DIGEST_EMAIL, or TREASURY_EXPORT_EMAIL"
      );
    }

    const emailBody = buildInviteExpiryReminderBody({
      expiringCount: count,
      thresholdHours,
      invites: invites.map((inv) => ({
        batchLabel: inv.batchLabel,
        expiresAt: inv.expiresAt!,
        createdAt: inv.createdAt,
      })),
    });

    const emailSent = await sendEmailNotification({
      to: recipientEmail,
      subject: `⚠️ ${count} invite${count !== 1 ? "s" : ""} expiring soon`,
      body: emailBody,
    });

    job.result = {
      expiringCount: count,
      emailSent,
      recipientEmail,
      thresholdHours,
      durationMs: Date.now() - startTime,
    };

    if (!emailSent) {
      throw new Error("Failed to send invite expiry reminder email");
    }

    // Create notification for completed reminder job
    await createNotification({
      userId: job.ownerId ?? null,
      type: "INVITE_REMINDER_SENT",
      title: "Invite expiry reminder sent",
      body: `Notified ${recipientEmail} about ${count} expiring invite${count !== 1 ? "s" : ""}.`,
      metadata: { jobId: job.id, ...job.result },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await createNotification({
      userId: job.ownerId ?? null,
      type: "INVITE_REMINDER_FAILED",
      title: "Invite expiry reminder failed",
      body: `Failed to send invite expiry reminder: ${errorMsg}`,
      metadata: { jobId: job.id, error: errorMsg },
    });
    throw error;
  }
});
