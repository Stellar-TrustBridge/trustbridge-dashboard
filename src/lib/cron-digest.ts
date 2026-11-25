import "server-only";

import { recordAuditLog } from "@/lib/audit";
import { buildDigestEmailBody, sendEmailNotification } from "@/lib/email";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { toContributorRow } from "@/lib/registrations";
import type { ContributorRow } from "@/types";

const logger = new StructuredLogger("cron-digest");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DigestCadence = "daily" | "weekly";
export type DigestStatus = "ok" | "error" | "skipped";

export const DIGEST_SUPPRESSION_REASON_CODES = {
  EMPTY_CHANGE_SET: "EMPTY_CHANGE_SET",
  DRY_RUN: "DRY_RUN",
  RATE_LIMITED: "RATE_LIMITED",
  QUIET_HOURS: "QUIET_HOURS",
} as const;

export type DigestSuppressionReasonCode =
  (typeof DIGEST_SUPPRESSION_REASON_CODES)[keyof typeof DIGEST_SUPPRESSION_REASON_CODES];

export interface DigestSnapshot {
  totalContributors: number;
  readyCount: number;
  lowReserveCount: number;
  notReadyCount: number;
  slaBreachCount: number;
}

export interface DigestChangeSet {
  hasChanges: boolean;
  actionableCount: number;
  deltaContributors: number;
  deltaReady: number;
  deltaNotReady: number;
  deltaSlaBreaches: number;
  reasonCode: DigestSuppressionReasonCode | null;
}

export interface DigestSuppressionMetrics {
  suppressedEmptyCount: number;
  dryRunRecordedCount: number;
  sentCount: number;
  lastSuppressedAt: string | null;
}

export interface NotReadyEntry {
  githubUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
}

export interface SlaBreachEntry {
  disputeId: string;
  /** Deep link to the dispute detail page (no PII beyond the id). */
  url: string;
  ageHours: number;
}

export interface DigestResult {
  status: DigestStatus;
  startedAt: string;
  durationMs: number;
  cadence?: DigestCadence;
  totalContributors?: number;
  readyCount?: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  /** Set when DIGEST_INCLUDE_FULL_LIST=true */
  notReadyList?: NotReadyEntry[];
  /** Count of disputes older than the configured SLA threshold. */
  slaBreachCount?: number;
  /** Set when DIGEST_INCLUDE_FULL_LIST=true */
  slaBreachList?: SlaBreachEntry[];
  destination?: string;
  emailSent?: boolean;
  /** True when the digest email was intentionally suppressed (e.g. empty Wave change set). */
  suppressed?: boolean;
  /** True when this run recorded a dry-run metric without sending mail. */
  dryRun?: boolean;
  /** Machine-readable reason code when skipped or suppressed. */
  reasonCode?: DigestSuppressionReasonCode;
  error?: string;
}

export interface RunDigestOptions {
  actorId?: string | null;
  actorLogin?: string | null;
  /** Override destination email (default: DIGEST_EMAIL → TREASURY_EXPORT_EMAIL) */
  destinationEmail?: string;
  /** Override cadence label for the subject line (default: resolved from env) */
  cadence?: DigestCadence;
  /** Bypass the min-interval rate gate, quiet hours, and empty-digest suppression */
  force?: boolean;
  /** Record metrics & audit trail without sending email */
  dryRun?: boolean;
  /** Override DIGEST_SUPPRESS_EMPTY for this run */
  suppressEmpty?: boolean;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Minimum milliseconds between digest runs. Defaults to 1 hour so that a
 * misconfigured Vercel Cron that fires every minute cannot spam the inbox.
 */
function getMinIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.DIGEST_CRON_MIN_INTERVAL_MS ?? "3600000",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_600_000;
}

/**
 * Digest destination email. Falls back to the treasury export email so teams
 * only have to configure one destination for both exports and digests.
 */
export function getDigestDestinationEmail(): string {
  return (
    process.env.DIGEST_EMAIL?.trim() ||
    process.env.TREASURY_EXPORT_EMAIL?.trim() ||
    process.env.CRON_EXPORT_EMAIL?.trim() ||
    ""
  );
}

/**
 * Resolve the configured cadence label from `DIGEST_CADENCE`.
 * Anything other than "weekly" is treated as "daily" (fail-safe default).
 */
export function getConfiguredCadence(): DigestCadence {
  const raw = process.env.DIGEST_CADENCE?.trim().toLowerCase();
  return raw === "weekly" ? "weekly" : "daily";
}

/**
 * Whether the full per-contributor list should be included in the digest.
 * Default: false (counts + dashboard link only).
 * Enable with DIGEST_INCLUDE_FULL_LIST=true.
 */
export function isFullListEnabled(): boolean {
  const raw = process.env.DIGEST_INCLUDE_FULL_LIST?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Dispute SLA threshold in hours. Disputes older than this are flagged as
 * SLA breaches in the digest. Defaults to 72 hours.
 */
export function getDisputeSlaHours(): number {
  const parsed = Number.parseInt(process.env.DISPUTE_SLA_HOURS ?? "72", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 72;
}

/**
 * Whether empty-digest suppression is enabled (`DIGEST_SUPPRESS_EMPTY`).
 * Enabled by default so empty Wave digests never train maintainers to ignore mail.
 * Set `DIGEST_SUPPRESS_EMPTY=false` (or `0`/`no`) to always send.
 */
export function isEmptyDigestSuppressionEnabled(): boolean {
  const raw = process.env.DIGEST_SUPPRESS_EMPTY?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

/**
 * Compute whether the current Wave digest snapshot represents a non-empty
 * change set compared to the previous sent snapshot.
 *
 * A change set is empty when:
 * - There are 0 contributors and 0 SLA breaches, OR
 * - There is a previous snapshot with identical counts AND 0 not-ready / 0 SLA breaches.
 */
export function computeDigestChangeSet(
  current: DigestSnapshot,
  previous: DigestSnapshot | null
): DigestChangeSet {
  const actionableCount = current.notReadyCount + current.slaBreachCount;
  const base: DigestSnapshot = previous ?? {
    totalContributors: 0,
    readyCount: 0,
    lowReserveCount: 0,
    notReadyCount: 0,
    slaBreachCount: 0,
  };

  const deltaContributors = current.totalContributors - base.totalContributors;
  const deltaReady = current.readyCount - base.readyCount;
  const deltaNotReady = current.notReadyCount - base.notReadyCount;
  const deltaSlaBreaches = current.slaBreachCount - base.slaBreachCount;

  const hasDelta =
    deltaContributors !== 0 ||
    deltaReady !== 0 ||
    deltaNotReady !== 0 ||
    deltaSlaBreaches !== 0;

  const isCompletelyEmpty =
    current.totalContributors === 0 && current.slaBreachCount === 0;
  const hasChanges = !isCompletelyEmpty && (actionableCount > 0 || hasDelta);

  return {
    hasChanges,
    actionableCount,
    deltaContributors,
    deltaReady,
    deltaNotReady,
    deltaSlaBreaches,
    reasonCode: hasChanges ? null : DIGEST_SUPPRESSION_REASON_CODES.EMPTY_CHANGE_SET,
  };
}

/**
 * Base URL used to build deep links in the digest. Falls back to the
 * configured app URL, then to a relative path so links never leak hosts.
 */
function getAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    "";
  return raw.replace(/\/+$/, "");
}

/**
 * Org timezone used to render freeze windows in the digest. Mirrors the
 * resolution used by `src/lib/freeze-window.ts` so operator-facing copy stays
 * consistent with the freeze-status API. Falls back to UTC when unset or
 * invalid so digests never fail on a bad env value.
 */
export function getDigestOrgTimezone(): string {
  const raw = process.env.ORG_TIMEZONE?.trim();
  if (!raw) return "UTC";
  try {
    // Throws RangeError for unknown IANA zones.
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    logger.warn("cron_digest_invalid_org_timezone", { timezone: raw });
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Quiet hours (#696)
// ---------------------------------------------------------------------------

export interface QuietHoursConfig {
  /** Minutes after local midnight when quiet hours begin (inclusive). */
  startMinute: number;
  /** Minutes after local midnight when quiet hours end (exclusive). */
  endMinute: number;
  /** IANA timezone the window is evaluated in. */
  timeZone: string;
}

const QUIET_HOURS_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `DIGEST_QUIET_HOURS` ("HH:MM-HH:MM", 24h) and `DIGEST_TIMEZONE`
 * (IANA name, default "UTC"). Returns null when quiet hours are unset or
 * misconfigured; a bad value is logged and never blocks the digest.
 */
export function getQuietHoursConfig(): QuietHoursConfig | null {
  const raw = process.env.DIGEST_QUIET_HOURS?.trim();
  if (!raw) return null;

  const match = QUIET_HOURS_PATTERN.exec(raw);
  if (!match) {
    logger.warn("cron_digest_quiet_hours_invalid", { value: raw });
    return null;
  }
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(match[3]) * 60 + Number(match[4]);
  if (startMinute === endMinute) {
    logger.warn("cron_digest_quiet_hours_empty", { value: raw });
    return null;
  }

  const timeZone = process.env.DIGEST_TIMEZONE?.trim() || "UTC";
  if (!isValidTimeZone(timeZone)) {
    logger.warn("cron_digest_timezone_invalid", { value: timeZone });
    return null;
  }

  return { startMinute, endMinute, timeZone };
}

/**
 * True when `at` falls inside the quiet window in the configured timezone.
 * Windows may cross midnight (e.g. 22:00-07:00). DST is handled by
 * evaluating the wall-clock time in `timeZone` via Intl.
 */
export function isWithinQuietHours(at: Date, config: QuietHoursConfig): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const local = hour * 60 + minute;

  const { startMinute, endMinute } = config;
  return startMinute < endMinute
    ? local >= startMinute && local < endMinute
    : local >= startMinute || local < endMinute;
}

// ---------------------------------------------------------------------------
// Rate gate (in-process; mirrors cron-export.ts)
// ---------------------------------------------------------------------------

let lastRunAt: number | null = null;
let lastResult: DigestResult | null = null;
let lastSentSnapshot: DigestSnapshot | null = null;
let suppressionMetrics: DigestSuppressionMetrics = {
  suppressedEmptyCount: 0,
  dryRunRecordedCount: 0,
  sentCount: 0,
  lastSuppressedAt: null,
};

/** Return the last digest run result for the health/status endpoint. */
export function getLastDigestHealth(): DigestResult | null {
  return lastResult;
}

/** Return in-process digest suppression & dry-run metrics. */
export function getDigestSuppressionMetrics(): DigestSuppressionMetrics {
  return { ...suppressionMetrics };
}

/** Reset in-process state. For testing only. */
export function resetDigestState(): void {
  lastRunAt = null;
  lastResult = null;
  lastSentSnapshot = null;
  suppressionMetrics = {
    suppressedEmptyCount: 0,
    dryRunRecordedCount: 0,
    sentCount: 0,
    lastSuppressedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Not-ready reason resolver
// ---------------------------------------------------------------------------

function resolveReason(
  c: ContributorRow
): "unfunded" | "no_trustline" | "low_reserve" {
  if (c.readiness === "low_reserve") return "low_reserve";
  if (!c.funded) return "unfunded";
  return "no_trustline";
}

// ---------------------------------------------------------------------------
// SLA breach detection
// ---------------------------------------------------------------------------

/**
 * Find disputes that have exceeded the configured SLA threshold.
 *
 * Only open disputes (not resolved/dismissed) are considered. Returns a
 * count plus, when the full list is enabled, deep links keyed by dispute id
 * so no contributor PII is leaked beyond the existing masking policy.
 */
export async function findDisputeSlaBreaches(
  now: number = Date.now(),
  includeFullList: boolean = isFullListEnabled()
): Promise<{ count: number; list: SlaBreachEntry[] }> {
  if (!prisma.dispute?.findMany) {
    return { count: 0, list: [] };
  }

  const slaHours = getDisputeSlaHours();
  const cutoff = new Date(now - slaHours * 60 * 60 * 1000);
  const baseUrl = getAppBaseUrl();

  const disputes = await prisma.dispute.findMany({
    where: {
      status: { in: ["open", "under_review"] },
      createdAt: { lt: cutoff },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const list: SlaBreachEntry[] = includeFullList
    ? disputes.map((d) => ({
        disputeId: d.id,
        url: `${baseUrl}/disputes/${d.id}`,
        ageHours: Math.floor(
          (now - new Date(d.createdAt).getTime()) / (60 * 60 * 1000)
        ),
      }))
    : [];

  return { count: disputes.length, list };
}

// ---------------------------------------------------------------------------
// Core digest runner
// ---------------------------------------------------------------------------

/**
 * Run the contributor not-ready digest.
 *
 * Privacy default: sends counts + dashboard link only.
 * Opt-in: set `DIGEST_INCLUDE_FULL_LIST=true` to include per-contributor
 * GitHub usernames and block reasons in the email body.
 *
 * Never throws — all errors are caught, audited, and returned as
 * `{ status: "error" }` so cron schedulers don't enter retry storms.
 */
export async function runCronDigest(
  options: RunDigestOptions = {}
): Promise<DigestResult> {
  const now = Date.now();
  const minIntervalMs = getMinIntervalMs();

  // ── Rate gate ─────────────────────────────────────────────────────────────
  if (!options.force && lastRunAt !== null && now - lastRunAt < minIntervalMs) {
    logger.info("cron_digest_skipped_rate_limited", {
      msSinceLastRun: now - lastRunAt,
      minIntervalMs,
    });
    return {
      status: "skipped",
      reasonCode: DIGEST_SUPPRESSION_REASON_CODES.RATE_LIMITED,
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
      error: `Rate limited: minimum interval between digests is ${minIntervalMs}ms`,
    };
  }

  // ── Quiet hours ───────────────────────────────────────────────────────────
  // Checked before lastRunAt is set, so a skipped run never rate-limits the
  // first run after quiet hours end. Manual `force` runs are not deferred.
  const quietHours = getQuietHoursConfig();
  if (!options.force && quietHours && isWithinQuietHours(new Date(now), quietHours)) {
    logger.info("cron_digest_skipped_quiet_hours", { timeZone: quietHours.timeZone });
    return {
      status: "skipped",
      reasonCode: DIGEST_SUPPRESSION_REASON_CODES.QUIET_HOURS,
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
      error: `Quiet hours: digests are not sent during DIGEST_QUIET_HOURS (${quietHours.timeZone})`,
    };
  }

  lastRunAt = now;
  const startedAt = new Date(now).toISOString();
  const cadence = options.cadence ?? getConfiguredCadence();
  const includeFullList = isFullListEnabled();
  const orgTimezone = getDigestOrgTimezone();

  logger.info("cron_digest_started", {
    startedAt,
    cadence,
    includeFullList,
    orgTimezone,
  });

  try {
    // ── Fetch all active registrations ───────────────────────────────────────
    const registrations = await prisma.registration.findMany({
      where: { deletedAt: null },
      include: {
        user: {
          select: { githubUsername: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const contributors: ContributorRow[] = registrations.map(toContributorRow);
    const totalContributors = contributors.length;

    // ── Tally readiness ───────────────────────────────────────────────────────
    let readyCount = 0;
    let lowReserveCount = 0;
    let notReadyCount = 0;

    const notReadyList: NotReadyEntry[] = [];

    for (const c of contributors) {
      if (c.readiness === "ready") {
        readyCount++;
      } else if (c.readiness === "low_reserve") {
        lowReserveCount++;
        notReadyCount++;
        if (includeFullList) {
          notReadyList.push({
            githubUsername: c.githubUsername,
            reason: "low_reserve",
          });
        }
      } else {
        notReadyCount++;
        if (includeFullList) {
          notReadyList.push({
            githubUsername: c.githubUsername,
            reason: resolveReason(c),
          });
        }
      }
    }

    // ── Dispute SLA breaches ─────────────────────────────────────────────────
    const slaBreaches = await findDisputeSlaBreaches(now, includeFullList);

    // ── Empty-digest suppression & dry-run metric (#795) ─────────────────────
    const currentSnapshot: DigestSnapshot = {
      totalContributors,
      readyCount,
      lowReserveCount,
      notReadyCount,
      slaBreachCount: slaBreaches.count,
    };
    const changeSet = computeDigestChangeSet(currentSnapshot, lastSentSnapshot);
    const suppressEmpty = options.suppressEmpty ?? isEmptyDigestSuppressionEnabled();
    const shouldSuppressEmpty =
      !options.force && suppressEmpty && !changeSet.hasChanges;
    const isDryRun = Boolean(options.dryRun) || shouldSuppressEmpty;

    const destination =
      options.destinationEmail?.trim() || getDigestDestinationEmail();

    if (isDryRun) {
      const reasonCode = options.dryRun
        ? DIGEST_SUPPRESSION_REASON_CODES.DRY_RUN
        : DIGEST_SUPPRESSION_REASON_CODES.EMPTY_CHANGE_SET;
      const durationMs = Date.now() - now;

      suppressionMetrics.dryRunRecordedCount++;
      if (shouldSuppressEmpty) {
        suppressionMetrics.suppressedEmptyCount++;
        suppressionMetrics.lastSuppressedAt = startedAt;
      }

      logger.info("cron_digest_suppressed_dry_run", {
        cadence,
        reasonCode,
        totalContributors,
        readyCount,
        notReadyCount,
        slaBreachCount: slaBreaches.count,
        dryRun: true,
        suppressedEmptyCount: suppressionMetrics.suppressedEmptyCount,
        dryRunRecordedCount: suppressionMetrics.dryRunRecordedCount,
      });

      await recordAuditLog({
        action: "digest.cron",
        actorId: options.actorId ?? null,
        actorLogin: options.actorLogin ?? "scheduler:cron",
        metadata: {
          cadence,
          totalContributors,
          readyCount,
          lowReserveCount,
          notReadyCount,
          slaBreachCount: slaBreaches.count,
          emailSent: false,
          suppressed: true,
          dryRun: true,
          reasonCode,
        },
      });

      const suppressedResult: DigestResult = {
        status: "skipped",
        suppressed: true,
        dryRun: true,
        reasonCode,
        startedAt,
        durationMs,
        cadence,
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        notReadyList: includeFullList ? notReadyList : undefined,
        slaBreachCount: slaBreaches.count,
        slaBreachList: includeFullList ? slaBreaches.list : undefined,
        destination: destination || undefined,
        emailSent: false,
      };

      lastResult = suppressedResult;
      return suppressedResult;
    }

    // ── Email ─────────────────────────────────────────────────────────────────
    let emailSent = false;

    if (destination) {
      const emailBody = buildDigestEmailBody({
        cadence,
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        notReadyList: includeFullList ? notReadyList : undefined,
        slaBreachCount: slaBreaches.count,
        slaBreachList: includeFullList ? slaBreaches.list : undefined,
        generatedAt: startedAt,
        orgTimezone,
      });

      const cadenceLabel = cadence === "weekly" ? "Weekly" : "Daily";
      emailSent = await sendEmailNotification({
        to: destination,
        subject: `[TrustBridge] ${cadenceLabel} Not-Ready Contributor Digest`,
        body: emailBody,
      });

      if (!emailSent) {
        logger.warn("cron_digest_email_failed", { destination });
      }
    } else {
      logger.info("cron_digest_no_destination_configured", {
        totalContributors,
        notReadyCount,
        slaBreachCount: slaBreaches.count,
      });
    }

    if (emailSent || !destination) {
      lastSentSnapshot = currentSnapshot;
    }
    if (emailSent) {
      suppressionMetrics.sentCount++;
    }

    const durationMs = Date.now() - now;

    await recordAuditLog({
      action: "digest.cron",
      actorId: options.actorId ?? null,
      actorLogin: options.actorLogin ?? "scheduler:cron",
      metadata: {
        cadence,
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        slaBreachCount: slaBreaches.count,
        emailSent,
      },
    });

    const result: DigestResult = {
      status: "ok",
      startedAt,
      durationMs,
      cadence,
      totalContributors,
      readyCount,
      lowReserveCount,
      notReadyCount,
      notReadyList: includeFullList ? notReadyList : undefined,
      slaBreachCount: slaBreaches.count,
      slaBreachList: includeFullList ? slaBreaches.list : undefined,
      destination: destination || undefined,
      emailSent,
    };

    lastResult = result;
    logger.info("cron_digest_completed", {
      durationMs,
      notReadyCount,
      slaBreachCount: slaBreaches.count,
      emailSent,
    });

    return result;
  } catch (err) {
    const durationMs = Date.now() - now;
    const message = err instanceof Error ? err.message : String(err);

    logger.error("cron_digest_failed", { error: message, durationMs });

    await Promise.resolve(
      recordAuditLog({
        action: "digest.cron.failed",
        actorId: options.actorId ?? null,
        actorLogin: options.actorLogin ?? "scheduler:cron",
        metadata: { error: message, durationMs },
      })
    ).catch(() => undefined);

    const result: DigestResult = {
      status: "error",
      startedAt,
      durationMs,
      cadence,
      error: message,
    };

    lastResult = result;
    return result;
  }
}
