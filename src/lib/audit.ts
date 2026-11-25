import "server-only";

import type { Prisma } from "@prisma/client";

import { toAuditLogEntry } from "@/lib/audit-format";
import { prisma } from "@/lib/prisma";
import type { AuditAction, AuditLogEntry } from "@/types";

export interface RecordAuditInput {
  action: AuditAction | string;
  actorId?: string | null;
  actorLogin?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persist a maintainer action to the audit log.
 *
 * Auditing is best-effort: a logging failure must never break the primary
 * action, so errors are swallowed (and surfaced to the server console).
 */
export async function recordAuditLog(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actorId ?? null,
        actorLogin: input.actorLogin ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        metadata:
          (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record audit log", input.action, error);
  }
}

/**
 * Record a pubnet/testnet switch performed from settings.
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so the network switch trail stays consistent across call
 * sites. Best-effort like the underlying helper.
 */
export async function recordNetworkSwitchAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  fromNetwork: string;
  toNetwork: string;
  confirmed: boolean;
}): Promise<void> {
  await recordAuditLog({
    action: "settings.network.switch",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.toNetwork,
    targetLabel: input.toNetwork,
    metadata: {
      fromNetwork: input.fromNetwork,
      toNetwork: input.toNetwork,
      confirmed: input.confirmed,
    },
  });
}

/**
 * Record a dispute status transition performed by a maintainer.
 *
 * Wraps {@link recordAuditLogStrict} with the canonical action name and a
 * stable metadata shape so the dispute trail stays consistent across call
 * sites. Strict: a transition must not succeed without an audit record, so
 * closed cases cannot reopen without a trail.
 */
export async function recordDisputeTransitionAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  disputeId: string;
  fromStatus: string;
  toStatus: string;
  reason?: string | null;
}): Promise<void> {
  await recordAuditLogStrict({
    action: "dispute.status.transition",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.disputeId,
    targetLabel: input.disputeId,
    metadata: {
      disputeId: input.disputeId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
    },
  });
}

/**
 * Record a registration retention dry-run report generation.
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so operators can trace rehearsals before purging contributor
 * PII. Best-effort like the underlying helper; the report itself never
 * contains unmasked addresses (see `src/lib/cron-export.ts`).
 */
export async function recordRetentionDryRunAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  format: "json" | "csv";
  candidateCount: number;
  cutoff: string;
  reasonCode?: string | null;
}): Promise<void> {
  await recordAuditLog({
    action: "registrations.retention.dry_run",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.cutoff,
    targetLabel: input.format,
    metadata: {
      format: input.format,
      candidateCount: input.candidateCount,
      cutoff: input.cutoff,
      reasonCode: input.reasonCode ?? null,
    },
  });
}

/**
 * Record a self-service registration delete performed via
 * `POST /api/register/delete`.
 *
 * The delete route implements a **soft-delete** policy: the contributor row is
 * retained with `deletedAt` set (and PII redacted per the retention policy) so
 * Wave maintainers can restore it within the retention window. This helper
 * encodes that policy in the audit trail with a stable metadata shape so the
 * soft-delete versus hard-delete semantics stay observable and testable.
 *
 * `mode` is always `"soft"` for the current route; it is recorded explicitly
 * so any future hard-delete path must declare itself and cannot silently drift
 * the retention contract. Best-effort like {@link recordAuditLog}.
 */
export async function recordRegistrationDeleteAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  registrationId: string;
  mode: "soft" | "hard";
  restorable: boolean;
  reasonCode?: string | null;
}): Promise<void> {
  await recordAuditLog({
    action: "registrations.delete",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.registrationId,
    targetLabel: input.registrationId,
    metadata: {
      registrationId: input.registrationId,
      mode: input.mode,
      restorable: input.restorable,
      reasonCode: input.reasonCode ?? null,
    },
  });
}

/**
 * Record a DLQ replay attempt (success or failure).
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so the DLQ replay trail captures who forced a Wave
 * contributor recheck, which job was replayed, and the outcome. Best-effort
 * like the underlying helper: an audit failure must not break the replay.
 */
export async function recordDlqReplayAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  jobId: string;
  outcome: "success" | "failure";
  reason?: string | null;
  error?: string | null;
}): Promise<void> {
  await recordAuditLog({
    action: "queue.dlq.replay",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.jobId,
    targetLabel: input.jobId,
    metadata: {
      jobId: input.jobId,
      outcome: input.outcome,
      reason: input.reason ?? null,
      error: input.error ?? null,
    },
  });
}

/**
 * Record a manual circuit-breaker force-open (or its clear/expiry).
 *
 * Wraps {@link recordAuditLogStrict} with the canonical action name and a
 * stable metadata shape so the kill-switch trail captures who forced a Wave
 * dependency open, why, and when it auto-expires. Strict: a privileged
 * force-open must not succeed without an audit record. Metadata never
 * contains secrets or unmasked addresses — only the breaker name, reason,
 * and expiry window.
 */
export async function recordCircuitBreakerForceOpenAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  breaker: string;
  reason: string;
  expiresAt: string;
  outcome: "force_open" | "clear" | "expire";
}): Promise<void> {
  await recordAuditLogStrict({
    action: "circuit_breaker.force_open",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.breaker,
    targetLabel: input.breaker,
    metadata: {
      breaker: input.breaker,
      reason: input.reason,
      expiresAt: input.expiresAt,
      outcome: input.outcome,
    },
  });
}

/**
 * Persist a maintainer action to the audit log, surfacing failures.
 *
 * Unlike {@link recordAuditLog}, this variant rejects when the audit write
 * fails. Use it for privileged flows (e.g. ban appeal notes) where an
 * unaudited action must not be allowed to succeed.
 */
export async function recordAuditLogStrict(
  input: RecordAuditInput,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actorId ?? null,
      actorLogin: input.actorLogin ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      metadata:
        (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
    },
  });
}

/** Read the most recent audit log entries, newest first. */
export async function getRecentAuditLog(limit = 50): Promise<AuditLogEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return rows.map(toAuditLogEntry);
}

/** Default page size for paginated audit exports. */
export const AUDIT_EXPORT_DEFAULT_PAGE_SIZE = 500;

/** Hard cap on a single export page so large orgs cannot request unbounded rows. */
export const AUDIT_EXPORT_MAX_PAGE_SIZE = 1000;

/** Stable reason codes surfaced by {@link getAuditLogPage} on failure. */
export type AuditExportReasonCode =
  | "invalid_cursor"
  | "invalid_page_size";

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /** Cursor to pass as `cursor` for the next page, or `null` when exhausted. */
  nextCursor: string | null;
  /** Number of rows returned in this page. */
  count: number;
}

/**
 * Thrown by {@link getAuditLogPage} for malformed pagination input.
 *
 * Carries a stable `reasonCode` so the API route can map it to a documented
 * 400 response without leaking internals.
 */
export class AuditExportError extends Error {
  readonly reasonCode: AuditExportReasonCode;

  constructor(reasonCode: AuditExportReasonCode, message: string) {
    super(message);
    this.name = "AuditExportError";
    this.reasonCode = reasonCode;
  }
}

function normalizePageSize(pageSize?: number | null): number {
  if (pageSize === undefined || pageSize === null) {
    return AUDIT_EXPORT_DEFAULT_PAGE_SIZE;
  }
  if (!Number.isFinite(pageSize) || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new AuditExportError(
      "invalid_page_size",
      "pageSize must be a positive integer",
    );
  }
  return Math.min(pageSize, AUDIT_EXPORT_MAX_PAGE_SIZE);
}

/**
 * Read a single page of audit log entries, newest first, using cursor
 * pagination so large orgs can stream exports in bounded chunks instead of
 * loading the full history (which times out on Wave compliance exports).
 *
 * Pass the returned `nextCursor` back as `cursor` to fetch the next page.
 * A `null` `nextCursor` means the export is exhausted. Malformed pagination
 * input throws {@link AuditExportError} with a stable reason code.
 */
export async function getAuditLogPage(options: {
  cursor?: string | null;
  pageSize?: number | null;
} = {}): Promise<AuditLogPage> {
  const take = normalizePageSize(options.pageSize);
  const cursor = options.cursor ?? null;

  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0)) {
    throw new AuditExportError("invalid_cursor", "cursor must be a non-empty id");
  }

  // Fetch one extra row to detect whether another page exists without a
  // second round-trip.
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const pageRows = hasMore ? rows.slice(0, take) : rows;
  const entries = pageRows.map(toAuditLogEntry);
  const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null;

  return { entries, nextCursor, count: entries.length };
}
