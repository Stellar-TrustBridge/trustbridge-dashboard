import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";

import type { WavePublicOverallStatus, WavePublicStatus } from "@/lib/wave-status";

interface WaveStatusBannerProps {
  /** Full wave status payload from `GET /api/wave-status`. */
  status: WavePublicStatus;
  /** Extra class names for the wrapper element. */
  className?: string;
}

function bannerStyles(overall: WavePublicOverallStatus): {
  wrapper: string;
  icon: React.ReactNode;
} {
  switch (overall) {
    case "ok":
      return {
        wrapper:
          "flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-emerald-900 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200",
        icon: (
          <CheckCircle
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        ),
      };
    case "degraded":
      return {
        wrapper:
          "flex items-start gap-3 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-amber-900 shadow-sm dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-200",
        icon: (
          <AlertTriangle
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
        ),
      };
    case "frozen":
    case "frozen_and_degraded":
      return {
        wrapper:
          "flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900 shadow-sm dark:border-red-700 dark:bg-red-950/60 dark:text-red-200",
        icon: (
          <XCircle
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400"
            aria-hidden="true"
          />
        ),
      };
  }
}

const OVERALL_LABEL: Record<WavePublicOverallStatus, string> = {
  ok: "All Wave systems operational",
  frozen: "Wave Freeze Window Active",
  degraded: "Wave Contract Sync Degraded",
  frozen_and_degraded: "Wave Frozen and Sync Degraded",
};

/**
 * Public Wave status banner.
 *
 * Renders nothing when `status.overallStatus === "ok"` and `hideWhenOk` is
 * true (the default). Pass `hideWhenOk={false}` to show the green "all good"
 * state in Storybook or on the public /status page.
 */
export function WaveStatusBanner({
  status,
  className = "",
}: WaveStatusBannerProps) {
  const { wrapper, icon } = bannerStyles(status.overallStatus);

  const fmt = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return iso;
    }
  };

  const showFreezeWindow =
    status.freeze.active && (status.freeze.start ?? status.freeze.end);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="wave-status-banner"
      data-overall-status={status.overallStatus}
      className={`${wrapper} ${className}`}
    >
      {icon}
      <div className="flex-1 text-sm">
        <h4 className="font-semibold">
          {OVERALL_LABEL[status.overallStatus]}
        </h4>
        <p className="mt-1">{status.message}</p>

        {showFreezeWindow && (
          <p className="mt-1 text-xs opacity-80">
            {fmt(status.freeze.start) && (
              <span>
                <span className="font-medium">From:</span>{" "}
                {fmt(status.freeze.start)}
              </span>
            )}
            {fmt(status.freeze.start) && fmt(status.freeze.end) && (
              <span className="mx-1">·</span>
            )}
            {fmt(status.freeze.end) && (
              <span>
                <span className="font-medium">Until:</span>{" "}
                {fmt(status.freeze.end)}
              </span>
            )}
          </p>
        )}

        {(status.overallStatus === "degraded" ||
          status.overallStatus === "frozen_and_degraded") &&
          status.queueLag.sinceLastSuccessMs !== null && (
            <p className="mt-1 text-xs opacity-80">
              Last successful sync:{" "}
              {Math.round(status.queueLag.sinceLastSuccessMs / 60_000)} min ago
              {" "}(threshold:{" "}
              {Math.round(status.queueLag.thresholdMs / 60_000)} min)
            </p>
          )}
      </div>
    </div>
  );
}
