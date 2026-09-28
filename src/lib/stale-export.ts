import type { ContributorRow } from "@/types";

export interface StaleExportOptions {
  /**
   * Maximum age in milliseconds before data is considered stale.
   * Defaults to `process.env.STALE_CSV_MAX_AGE_MS` or 24 hours.
   */
  maxAgeMs?: number;
  /**
   * When true, exports are blocked entirely when stale data is detected.
   * When false, exports are allowed with a user confirmation.
   */
  blockWhenStale?: boolean;
}

function getDefaultMaxAgeMs(): number {
  const fromEnv = Number.parseInt(process.env.STALE_CSV_MAX_AGE_MS ?? "86400000", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 86400000; // 24h
}

function parseLastCheckedAt(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Check whether any contributor data is older than the configured threshold.
 */
export function isExportStale(
  contributors: ContributorRow[],
  maxAgeMs?: number
): boolean {
  const threshold = maxAgeMs ?? getDefaultMaxAgeMs();
  const now = Date.now();

  return contributors.some((c) => {
    const checked = parseLastCheckedAt(c.lastCheckedAt);
    if (!checked) return true; // Never checked = stale
    return now - checked.getTime() > threshold;
  });
}

/**
 * Return the subset of contributors whose data is stale.
 */
export function getStaleContributors(
  contributors: ContributorRow[],
  maxAgeMs?: number
): ContributorRow[] {
  const threshold = maxAgeMs ?? getDefaultMaxAgeMs();
  const now = Date.now();

  return contributors.filter((c) => {
    const checked = parseLastCheckedAt(c.lastCheckedAt);
    if (!checked) return true;
    return now - checked.getTime() > threshold;
  });
}

/**
 * Filter contributors by last-checked date range.
 * @param contributors - Contributors to filter
 * @param afterMs - Only include contributors checked after this timestamp (ms since epoch)
 * @returns Filtered contributors within the date range
 */
export function filterContributorsByDateRange(
  contributors: ContributorRow[],
  afterMs: number
): ContributorRow[] {
  return contributors.filter((c) => {
    const checked = parseLastCheckedAt(c.lastCheckedAt);
    if (!checked) return false;
    return checked.getTime() >= afterMs;
  });
}

/**
 * Build a human-readable staleness summary for display.
 */
export function buildStalenessSummary(
  contributors: ContributorRow[],
  maxAgeMs?: number
): {
  stale: boolean;
  staleCount: number;
  totalCount: number;
  stalePercent: number;
  warning: string;
  allowExport: boolean;
} {
  const threshold = maxAgeMs ?? getDefaultMaxAgeMs();
  const stale = getStaleContributors(contributors, threshold);
  const staleCount = stale.length;
  const totalCount = contributors.length;
  const stalePercent = totalCount > 0 ? Math.round((staleCount / totalCount) * 100) : 0;

  const hours = Math.round(threshold / 3600000);
  const warning =
    staleCount > 0
      ? `${staleCount} of ${totalCount} contributors (${stalePercent}%) have not been verified in the last ${hours} hour(s). Exporting stale data may cause payout failures.`
      : "";

  return {
    stale: staleCount > 0,
    staleCount,
    totalCount,
    stalePercent,
    warning,
    allowExport: staleCount === 0,
  };
}

/**
 * Evaluate the stale-export guard for a treasury export request.
 *
 * Combines staleness detection with the caller's override intent so route
 * handlers can decide whether to block the export. When `blockWhenStale` is
 * true (the default), stale data is rejected; when false, the export is
 * allowed but the staleness summary is still surfaced for confirmation.
 */
export function evaluateStaleExportGuard(
  contributors: ContributorRow[],
  options: StaleExportOptions = {}
): {
  stale: boolean;
  blocked: boolean;
  staleCount: number;
  totalCount: number;
  stalePercent: number;
  warning: string;
  allowExport: boolean;
} {
  const summary = buildStalenessSummary(contributors, options.maxAgeMs);
  const blockWhenStale = options.blockWhenStale ?? true;

  return {
    ...summary,
    blocked: summary.stale && blockWhenStale,
    allowExport: !summary.stale || !blockWhenStale,
  };
}
