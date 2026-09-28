import type { JobProgressEvent } from "@/lib/use-job-progress";

interface BatchRecheckLiveRegionProps {
  event: JobProgressEvent | null;
  isStarting: boolean;
  isStreaming: boolean;
  error: string | null;
}

export function BatchRecheckLiveRegion({
  event,
  isStarting,
  isStreaming,
  error,
}: BatchRecheckLiveRegionProps) {
  let announcement = "";

  if (error) {
    announcement = `Batch re-check failed: ${error}`;
  } else if (event?.type === "completed") {
    const refreshed = event.result?.refreshed;
    announcement =
      typeof refreshed === "number"
        ? `Batch re-check completed. ${refreshed} contributors refreshed.`
        : "Batch re-check completed.";
  } else if (event?.type === "failed" || event?.type === "error") {
    announcement = `Batch re-check failed: ${event.error ?? event.message ?? "Unknown error"}`;
  } else if (event?.type === "processing") {
    announcement = "Batch re-check in progress.";
  } else if (event?.status === "pending") {
    announcement = "Batch re-check queued.";
  } else if (isStarting) {
    announcement = "Starting batch re-check.";
  } else if (isStreaming) {
    announcement = "Waiting for batch re-check progress.";
  }

  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
  );
}