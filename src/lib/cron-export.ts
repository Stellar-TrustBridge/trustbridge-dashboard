import "server-only";

import { randomUUID } from "node:crypto";

import { recordAuditLog } from "@/lib/audit";
import { buildContributorsCsv, getContributorsCsvFilename } from "@/lib/csv-export";
import { buildTreasuryExportEmailBody, sendEmailNotification } from "@/lib/email";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { toContributorRow } from "@/lib/registrations";
import { getStaleContributors, isExportStale } from "@/lib/stale-export";
import { trackServerCsvExported } from "@/lib/analytics";
import { sendCronExportAlert, pingCronExportSuccess } from "@/lib/cron-export-alert";
import type { ContributorRow } from "@/types";

const logger = new StructuredLogger("cron-export");
const CRON_EXPORT_LOCK_ID = "nightly-treasury-export";
const CRON_EXPORT_LOCK_LEASE_MS = 60 * 60 * 1000;

export type CronExportStatus = "ok" | "error" | "skipped";

/**
 * Stable reason codes emitted when a partial export artifact must be cleaned
 * up after a failed or aborted upload. Documented in `docs/CRON_EXPORT.md`.
 */
export type CronExportCleanupReasonCode =
  | "export.cleanup.upload_failed"
  | "export.cleanup.aborted"
  | "export.cleanup.cleanup_failed";

export interface CronExportResult {
  status: CronExportStatus;
  startedAt: string;
  durationMs: number;
  filename?: string;
  totalContributors?: number;
  readyCount?: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  staleCount?: number;
  isStale?: boolean;
  destination?: string;
  emailSent?: boolean;
  error?: string;
  /**
   * Reason code describing why a partial export artifact was cleaned up (or
   * why cleanup itself failed). Absent on the happy path.
   */
  cleanupReasonCode?: CronExportCleanupReasonCode;
  /**
   * Whether the partial artifact was successfully removed. `false` means the
   * cleanup attempt failed and the artifact may still exist for debugging.
   */
  cleanupSucceeded?: boolean;
}

export interface RunCronExportOptions {
  actorId?: string | null;
  actorLogin?: string | null;
  destinationEmail?: string;
  maxAgeMs?: number;
  force?: boolean;
}

/**
 * Dry-run report shape for the registration retention job.
 *
 * Describes what *would* be purged without performing any deletions. All
 * sensitive fields (emails, wallet addresses) are redacted per the existing
 * redaction policy before being emitted in JSON or CSV form.
 */
export type RetentionDryRunReasonCode =
  | "retention.expired"
  | "retention.soft_deleted"
  | "retention.orphaned";

export interface RetentionDryRunEntry {
  registrationId: string;
  githubUsername: string | null;
  email: string;
  walletAddress: string;
  reasonCode: RetentionDryRunReasonCode;
  deletedAt: string | null;
  updatedAt: string;
}

export interface RetentionDryRunReport {
  generatedAt: string;
  retentionDays: number;
  totalCandidates: number;
  byReason: Record<RetentionDryRunReasonCode, number>;
  entries: RetentionDryRunEntry[];
}

export interface RunRetentionDryRunOptions {
  retentionDays?: number;
  now?: number;
}

const DEFAULT_RETENTION_DAYS = 90;
const RETENTION_DRY_RUN_MAX_ENTRIES = 10000;

export const RETENTION_DRY_RUN_REASON_CODES: readonly RetentionDryRunReasonCode[] = [
  "retention.expired",
  "retention.soft_deleted",
  "retention.orphaned",
];

/**
 * Redact an email address, preserving only the first character of the local
 * part and the domain so operators can still triage without leaking PII.
 */
export function redactEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * Redact a wallet address, preserving only the first and last 4 characters.
 */
export function redactWalletAddress(address: string | null | undefined): string {
  if (!address) return "";
  if (address.length <= 8) return "***";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function getRetentionDays(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return override;
  }
  const parsed = Number.parseInt(
    process.env.REGISTRATION_RETENTION_DAYS ?? "",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/**
 * Build a dry-run report of registrations that the retention job would purge.
 *
 * Never deletes anything. Throws a stable error when the candidate set exceeds
 * `RETENTION_DRY_RUN_MAX_ENTRIES` so oversized inputs fail loudly rather than
 * silently truncating.
 */
export async function runRetentionDryRun(
  options: RunRetentionDryRunOptions = {}
): Promise<RetentionDryRunReport> {
  const now = options.now ?? Date.now();
  const retentionDays = getRetentionDays(options.retentionDays);
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);

  const registrations = await prisma.registration.findMany({
    where: {
      OR: [
        { deletedAt: { not: null, lte: cutoff } },
        { deletedAt: null, updatedAt: { lte: cutoff } },
      ],
    },
    include: {
      user: {
        select: { githubUsername: true },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: RETENTION_DRY_RUN_MAX_ENTRIES + 1,
  });

  if (registrations.length > RETENTION_DRY_RUN_MAX_ENTRIES) {
    throw new Error(
      `retention.dry_run.too_many_candidates: exceeds ${RETENTION_DRY_RUN_MAX_ENTRIES} entries`
    );
  }

  const byReason: Record<RetentionDryRunReasonCode, number> = {
    "retention.expired": 0,
    "retention.soft_deleted": 0,
    "retention.orphaned": 0,
  };

  const entries: RetentionDryRunEntry[] = registrations.map((registration) => {
    const reasonCode: RetentionDryRunReasonCode = registration.deletedAt
      ? "retention.soft_deleted"
      : registration.user?.githubUsername
        ? "retention.expired"
        : "retention.orphaned";
    byReason[reasonCode]++;

    return {
      registrationId: registration.id,
      githubUsername: registration.user?.githubUsername ?? null,
      email: redactEmail(registration.email),
      walletAddress: redactWalletAddress(registration.walletAddress),
      reasonCode,
      deletedAt: registration.deletedAt
        ? registration.deletedAt.toISOString()
        : null,
      updatedAt: registration.updatedAt.toISOString(),
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    retentionDays,
    totalCandidates: entries.length,
    byReason,
    entries,
  };
}

/**
 * Serialize a retention dry-run report as CSV. Columns are stable and
 * documented in `docs/REGISTRATION_RETENTION.md`.
 */
export function buildRetentionDryRunCsv(report: RetentionDryRunReport): string {
  const header = [
    "registrationId",
    "githubUsername",
    "email",
    "walletAddress",
    "reasonCode",
    "deletedAt",
    "updatedAt",
  ];

  const escape = (value: string | null): string => {
    const raw = value ?? "";
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };

  const rows = report.entries.map((entry) =>
    [
      entry.registrationId,
      entry.githubUsername,
      entry.email,
      entry.walletAddress,
      entry.reasonCode,
      entry.deletedAt,
      entry.updatedAt,
    ]
      .map(escape)
      .join(",")
  );

  return [header.join(","), ...rows].join("\n");
}

let lastRunAt: number | null = null;
let lastResult: CronExportResult | null = null;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function acquireCronExportLock(now: number): Promise<string | null> {
  const token = randomUUID();
  const leaseExpiresAt = new Date(now + CRON_EXPORT_LOCK_LEASE_MS);

  try {
    await prisma.cronExportLock.create({
      data: { id: CRON_EXPORT_LOCK_ID, token, leaseExpiresAt },
    });
    return token;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const reclaimed = await prisma.cronExportLock.updateMany({
    where: {
      id: CRON_EXPORT_LOCK_ID,
      leaseExpiresAt: { lte: new Date(now) },
    },
    data: { token, leaseExpiresAt },
  });

  return reclaimed.count === 1 ? token : null;
}

async function releaseCronExportLock(token: string): Promise<void> {
  try {
    await prisma.cronExportLock.deleteMany({
      where: { id: CRON_EXPORT_LOCK_ID, token },
    });
  } catch (error) {
    logger.error("cron_export_lock_release_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remove a partial export artifact left behind by a failed or aborted upload.
 *
 * Best-effort: never throws. Returns `true` when the artifact was removed (or
 * was already absent), `false` when cleanup itself failed. On failure the
 * artifact is intentionally retained for debugging and the failure is surfaced
 * through the existing cron-export alerting path with a stable reason code.
 */
export async function cleanupPartialExport(
  filename: string,
  reasonCode: CronExportCleanupReasonCode,
  removeArtifact: (filename: string) => Promise<void>
): Promise<boolean> {
  try {
    await removeArtifact(filename);
    logger.info("cron_export_partial_cleanup", {
      filename,
      reasonCode,
      cleanupSucceeded: true,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("cron_export_partial_cleanup_failed", {
      filename,
      reasonCode: "export.cleanup.cleanup_failed",
      originalReasonCode: reasonCode,
      error: message,
    });
    await sendCronExportAlert({
      reason: "export.cleanup.cleanup_failed",
      message: `Failed to remove partial export artifact ${filename}: ${message}`,
      filename,
    });
    return false;
  }
}
