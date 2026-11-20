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

export interface NotReadyEntry {
  githubUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
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
  destination?: string;
  emailSent?: boolean;
  error?: string;
}

export interface RunDigestOptions {
  actorId?: string | null;
  actorLogin?: string | null;
  /** Override destination email (default: DIGEST_EMAIL → TREASURY_EXPORT_EMAIL) */
  destinationEmail?: string;
  /** Override cadence label for the subject line (default: resolved from env) */
  cadence?: DigestCadence;
  /** Bypass the min-interval rate gate (useful for manual triggers) */
  force?: boolean;
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

/** Return the last digest run result for the health/status endpoint. */
export function getLastDigestHealth(): DigestResult | null {
  return lastResult;
}

/** Reset in-process state. For testing only. */
export function resetDigestState(): void {
  lastRunAt = null;
  lastResult = null;
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
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
      error: `Quiet hours: digests are not sent during DIGEST_QUIET_HOURS (${quietHours.timeZone})`,
    };
  }

  lastRunAt = now;
  const startedAt = new Date(now).toISOString();
  const cadence = options.cadence ?? getConfiguredCadence();
  const includeFullList = isFullListEnabled();

  logger.info("cron_digest_started", { startedAt, cadence, includeFullList });

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

    // ── Email ─────────────────────────────────────────────────────────────────
    const destination =
      options.destinationEmail?.trim() || getDigestDestinationEmail();

    let emailSent = false;

    if (destination) {
      const emailBody = buildDigestEmailBody({
        cadence,
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        notReadyList: includeFullList ? notReadyList : undefined,
        generatedAt: startedAt,
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
      });
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
        includeFullList,
        destination: destination || "none",
        emailSent,
        durationMs,
      },
    });

    lastResult = {
      status: "ok",
      startedAt,
      durationMs,
      cadence,
      totalContributors,
      readyCount,
      lowReserveCount,
      notReadyCount,
      notReadyList: includeFullList ? notReadyList : undefined,
      destination: destination || undefined,
      emailSent,
    };

    logger.info("cron_digest_completed", {
      totalContributors,
      readyCount,
      notReadyCount,
      cadence,
      durationMs,
    });

    return lastResult;
  } catch (error) {
    const durationMs = Date.now() - now;
    const message = error instanceof Error ? error.message : String(error);

    logger.error("cron_digest_failed", { error: message, durationMs });

    await recordAuditLog({
      action: "digest.cron.failed",
      actorId: options.actorId ?? null,
      actorLogin: options.actorLogin ?? "scheduler:cron",
      metadata: { error: message, durationMs },
    });

    lastResult = {
      status: "error",
      startedAt,
      durationMs,
      error: message,
    };

    return lastResult;
  }
}
