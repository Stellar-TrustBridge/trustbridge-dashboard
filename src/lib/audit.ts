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
