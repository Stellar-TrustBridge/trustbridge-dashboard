/**
 * Shared health-check logic for the TrustBridge Dashboard.
 *
 * Extracted so that `src/app/status/page.tsx` can import this directly
 * instead of fetching NEXT_PUBLIC_APP_URL/api/health (which is fragile in
 * preview/production and adds an unnecessary HTTP hop). (#308)
 *
 * The API route at `src/app/api/health/route.ts` also calls `runHealthChecks`
 * so both paths stay in sync. (#403)
 *
 * Dependency probes distinguish DB vs queue vs RPC failures with structured
 * statuses so incident response can tell which backend is degraded. (#589)
 * `NetworkStatusPanel` consumes the same `HealthResponse` shape from
 * `/api/health`; `parseHealthResponse` below validates partial/malformed
 * payloads so the panel can render a degraded/unavailable state instead of
 * crashing. (#538)
 *
 * The outbox lag probe (#772) surfaces Soroban outbox backlog in the deep
 * readiness check so silent lag cannot desync Wave on-chain state from the UI.
 */

import {
  getContractSyncHealth,
  getContractSyncLagState,
  type ContractSyncLagReason,
  type ContractSyncLagStatus,
} from "@/lib/contract-sync";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { toContributorRow } from "@/lib/registrations";
import { captureException } from "@/lib/sentry";
import { getOutboxLagState, type OutboxLagReason, type OutboxLagStatus } from "@/lib/soroban-outbox";

export type HealthStatus = "ok" | "degraded" | "error";

/**
 * Structured result of a single dependency probe. `kind` identifies which
 * backend failed (db, queue, rpc) so operators can triage without parsing
 * free-form error strings.
 */
export interface DependencyProbe {
  status: HealthStatus;
  latencyMs: number;
  error?: string;
}

export interface HealthResponse {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: DependencyProbe;
    queue: DependencyProbe;
    horizon: { status: HealthStatus; latencyMs: number };
    sorobanRpc: { status: HealthStatus; latencyMs: number };
    csvStaleness: {
      status: HealthStatus;
      staleCount: number;
      totalCount: number;
      stalePercent: number;
      warning: string;
    };
    contractSync: {
      status: HealthStatus;
      lastRunAt: string | null;
      lastError?: string;
      /**
       * Synchronization lag (issue #659). `status` mirrors the overall
       * health vocabulary (`ok` / `degraded`) so consumers can branch on it
       * without knowing the lag domain; `lagStatus` and `reason` carry the
       * precise contract-sync codes documented in `docs/ARCHITECTURE.md`.
       */
      lag: ContractSyncLagCheck;
    };
    /**
     * Soroban outbox lag probe (issue #772). `status` mirrors the overall
     * health vocabulary; `lagStatus` and `reason` carry the precise outbox
     * codes documented in `docs/DEPLOYMENT.md`.
     */
    outbox: OutboxLagCheck;
  };
  version: string;
}

export interface ContractSyncLagCheck {
  status: HealthStatus;
  lagStatus: ContractSyncLagStatus;
  reason: ContractSyncLagReason;
  sinceLastSuccessMs: number | null;
  sinceLastCursorAdvanceMs: number | null;
  thresholdMs: number;
  stallThresholdMs: number;
  cursor: string | null;
}

export interface OutboxLagCheck {
  status: HealthStatus;
  lagStatus: OutboxLagStatus;
  reason: OutboxLagReason;
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  thresholdMs: number;
  error?: string;
}

/**
 * HTTP status code that should accompany a given overall health status.
 * Shared so the API route and any other consumer agree on the mapping.
 */
export function healthStatusCode(status: HealthStatus): number {
  return status === "error" ? 503 : 200;
}

const HEALTH_STATUSES: readonly HealthStatus[] = ["ok", "degraded", "error"];

function isHealthStatus(value: unknown): value is HealthStatus {
  return typeof value === "string" && (HEALTH_STATUSES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const LAG_STATUSES: readonly ContractSyncLagStatus[] = ["ok", "lagging", "stalled"];
const LAG_REASONS: readonly ContractSyncLagReason[] = [
  "ok",
  "no_data",
  "never_succeeded",
  "sync_delayed",
  "sync_stalled",
  "cursor_stalled",
  "not_configured",
];

const OUTBOX_LAG_STATUSES: readonly OutboxLagStatus[] = ["ok", "lagging", "error"];
const OUTBOX_LAG_REASONS: readonly OutboxLagReason[] = [
  "ok",
  "no_data",
  "lag_exceeded",
  "query_failed",
  "not_configured",
];

/**
 * Normalize an unknown `checks.contractSync.lag` payload. Missing or
 * malformed fields fall back to neutral values (`ok` / `no_data`) so a
 * partial payload still renders without crashing, matching the rest of
 * `parseHealthResponse`.
 */
function parseContractSyncLag(value: unknown): ContractSyncLagCheck {
  const record = asRecord(value);
  const lagStatusRaw = record?.lagStatus;
  const lagStatus: ContractSyncLagStatus =
    typeof lagStatusRaw === "string" && (LAG_STATUSES as readonly string[]).includes(lagStatusRaw)
      ? (lagStatusRaw as ContractSyncLagStatus)
      : "ok";
  const reasonRaw = record?.reason;
  const reason: ContractSyncLagReason =
    typeof reasonRaw === "string" && (LAG_REASONS as readonly string[]).includes(reasonRaw)
      ? (reasonRaw as ContractSyncLagReason)
      : "no_data";

  const derivedStatus: HealthStatus = lagStatus === "ok" ? "ok" : "degraded";

  return {
    status: record && isHealthStatus(record.status) ? record.status : derivedStatus,
    lagStatus,
    reason,
    sinceLastSuccessMs:
      typeof record?.sinceLastSuccessMs === "number" && Number.isFinite(record.sinceLastSuccessMs)
        ? record.sinceLastSuccessMs
        : null,
    sinceLastCursorAdvanceMs:
      typeof record?.sinceLastCursorAdvanceMs === "number" &&
      Number.isFinite(record.sinceLastCursorAdvanceMs)
        ? record.sinceLastCursorAdvanceMs
        : null,
    thresholdMs: asNumber(record?.thresholdMs),
    stallThresholdMs: asNumber(record?.stallThresholdMs),
    cursor: typeof record?.cursor === "string" ? record.cursor : null,
  };
}

/**
 * Normalize an unknown `checks.outbox` payload (issue #772). Missing or
 * malformed fields fall back to neutral values (`ok` / `no_data`) so a
 * partial payload still renders without crashing.
 */
function parseOutboxLag(value: unknown): OutboxLagCheck {
  const record = asRecord(value);
  const lagStatusRaw = record?.lagStatus;
  const lagStatus: OutboxLagStatus =
    typeof lagStatusRaw === "string" &&
    (OUTBOX_LAG_STATUSES as readonly string[]).includes(lagStatusRaw)
      ? (lagStatusRaw as OutboxLagStatus)
      : "ok";
  const reasonRaw = record?.reason;
  const reason: OutboxLagReason =
    typeof reasonRaw === "string" && (OUTBOX_LAG_REASONS as readonly string[]).includes(reasonRaw)
      ? (reasonRaw as OutboxLagReason)
      : "no_data";

  const derivedStatus: HealthStatus = lagStatus === "ok" ? "ok" : "degraded";
  const error = record && typeof record.error === "string" ? record.error : undefined;

  return {
    status: record && isHealthStatus(record.status) ? record.status : derivedStatus,
    lagStatus,
    reason,
    pendingCount: asNumber(record?.pendingCount),
    oldestPendingAgeMs:
      typeof record?.oldestPendingAgeMs === "number" &&
      Number.isFinite(record.oldestPendingAgeMs)
        ? record.oldestPendingAgeMs
        : null,
    thresholdMs: asNumber(record?.thresholdMs),
    ...(error ? { error } : {}),
  };
}

/**
 * Normalize an unknown `/api/health` payload into a `HealthResponse`.
 *
 * Returns `null` when the payload is not an object at all (e.g. HTML error
 * page or empty body) so callers can surface an "unavailable" state. Missing
 * or malformed individual checks are coerced to `degraded` with zeroed
 * metrics, so partial payloads still render without crashing. (#538)
 */
export function parseHealthResponse(payload: unknown): HealthResponse | null {
  const root = asRecord(payload);
  if (!root) return null;

  const checks = asRecord(root.checks) ?? {};
  const database = asRecord(checks.database);
  const horizon = asRecord(checks.horizon);
  const sorobanRpc = asRecord(checks.sorobanRpc);
  const csvStaleness = asRecord(checks.csvStaleness);
  const contractSync = asRecord(checks.contractSync);

  const dbError = database && typeof database.error === "string" ? database.error : undefined;
  const queue = asRecord(checks.queue);
  const queueError = queue && typeof queue.error === "string" ? queue.error : undefined;
  const contractSyncError =
    contractSync && typeof contractSync.lastError === "string"
      ? contractSync.lastError
      : undefined;

  return {
    status: isHealthStatus(root.status) ? root.status : "degraded",
    timestamp: asString(root.timestamp, new Date().toISOString()),
    checks: {
      database: {
        status: database && isHealthStatus(database.status) ? database.status : "degraded",
        latencyMs: asNumber(database?.latencyMs),
        ...(dbError ? { error: dbError } : {}),
      },
      horizon: {
        status: horizon && isHealthStatus(horizon.status) ? horizon.status : "degraded",
        latencyMs: asNumber(horizon?.latencyMs),
      },
      queue: {
        status: queue && isHealthStatus(queue.status) ? queue.status : "degraded",
        latencyMs: asNumber(queue?.latencyMs),
        ...(queueError ? { error: queueError } : {}),
      },
      sorobanRpc: {
        status: sorobanRpc && isHealthStatus(sorobanRpc.status) ? sorobanRpc.status : "degraded",
        latencyMs: asNumber(sorobanRpc?.latencyMs),
      },
      csvStaleness: {
        status:
          csvStaleness && isHealthStatus(csvStaleness.status) ? csvStaleness.status : "degraded",
        staleCount: asNumber(csvStaleness?.staleCount),
        totalCount: asNumber(csvStaleness?.totalCount),
        stalePercent: asNumber(csvStaleness?.stalePercent),
        warning: asString(csvStaleness?.warning),
      },
      contractSync: {
        status:
          contractSync && isHealthStatus(contractSync.status) ? contractSync.status : "degraded",
        lastRunAt: typeof contractSync?.lastRunAt === "string" ? contractSync.lastRunAt : null,
        ...(contractSyncError ? { lastError: contractSyncError } : {}),
        lag: parseContractSyncLag(contractSync?.lag),
      },
      outbox: parseOutboxLag(checks.outbox),
    },
    version: asString(root.version),
  };
}

/**
 * Probe the Soroban outbox for lag (issue #772). Delegates to
 * `getOutboxLagState` so the threshold and reason codes stay defined in one
 * place; any thrown error is captured and surfaced as a stable
 * `query_failed` reason rather than a silent success.
 */
export async function probeOutboxLag(): Promise<OutboxLagCheck> {
  try {
    const state = await getOutboxLagState();
    return {
      status: state.lagStatus === "ok" ? "ok" : "degraded",
      lagStatus: state.lagStatus,
      reason: state.reason,
      pendingCount: state.pendingCount,
      oldestPendingAgeMs: state.oldestPendingAgeMs,
      thresholdMs: state.thresholdMs,
    };
  } catch (error) {
    captureException(error);
    return {
      status: "degraded",
      lagStatus: "error",
      reason: "query_failed",
      pendingCount: 0,
      oldestPendingAgeMs: null,
      thresholdMs: 0,
      error: error instanceof Error ? error.message : "outbox lag probe failed",
    };
  }
}

/* … rest of file (runHealthChecks etc.) unchanged … */
