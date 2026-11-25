import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Unified Soroban outbox adapter (Issue #488).
 *
 * Two complementary paths share one entry point:
 *
 * - **Production path** (`maintainerOrgId` present, no sink configured):
 *   persists via `prisma.sorobanOutbox.create` with status `PENDING` so the
 *   worker can claim and deliver the row.
 * - **In-memory path** (a sink is configured, or neither sink nor org is):
 *   keeps entries in a process-local Map. Used by tests and by the local
 *   worker loop; a delivered entry becomes `COMPLETED`, a throwing sink
 *   marks it `FAILED` (attempts + 1) and rethrows.
 *
 * Statuses are UPPERCASE to match the persisted rows the worker writes
 * (`PENDING` / `COMPLETED` / `FAILED`).
 */
export type SorobanOutboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export const DEFAULT_OUTBOX_LEASE_MS = 30_000;
export const MIN_OUTBOX_LEASE_MS = 1;
export const MAX_OUTBOX_LEASE_MS = 10 * 60 * 1000;
export const MAX_OUTBOX_WORKER_ID_LENGTH = 128;
export const MAX_OUTBOX_BATCH_SIZE = 1000;

export const SOROBAN_OUTBOX_REASON_CODES = {
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  INVALID_WORKER_ID: "INVALID_WORKER_ID",
  INVALID_LEASE_MS: "INVALID_LEASE_MS",
  INVALID_LEASE_TOKEN: "INVALID_LEASE_TOKEN",
  INVALID_BATCH_SIZE: "INVALID_BATCH_SIZE",
  ENTRY_NOT_FOUND: "ENTRY_NOT_FOUND",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  ALREADY_COMPLETED: "ALREADY_COMPLETED",
  NOT_CLAIMABLE: "NOT_CLAIMABLE",
  STALE_LEASE_TOKEN: "STALE_LEASE_TOKEN",
} as const;

export type SorobanOutboxReasonCode =
  (typeof SOROBAN_OUTBOX_REASON_CODES)[keyof typeof SOROBAN_OUTBOX_REASON_CODES];

export class SorobanOutboxError extends Error {
  readonly code: SorobanOutboxReasonCode;

  constructor(code: SorobanOutboxReasonCode, message: string) {
    super(message);
    this.name = "SorobanOutboxError";
    this.code = code;
  }
}

export interface SorobanOutboxEntry {
  id: string;
  payload: unknown;
  status: SorobanOutboxStatus;
  attempts: number;
  lastError?: string;
  /** Worker ID holding the active delivery lease while status === "PROCESSING". */
  leaseOwner?: string;
  /** Fencing token issued on claim; guards completion, failure, and release. */
  leaseToken?: string;
  /** ISO-8601 timestamp when the active delivery lease expires. */
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Delivery budget; defaults to OUTBOX_DEFAULT_MAX_ATTEMPTS when unset. */
  maxAttempts?: number;
}

export interface ClaimSorobanOutboxOptions {
  workerId: string;
  leaseMs?: number;
  now?: number;
  includeFailed?: boolean;
}

export interface SorobanOutboxClaimGrant {
  claimed: true;
  entry: SorobanOutboxEntry;
  leaseToken: string;
  leaseExpiresAt: string;
  reclaimedExpiredLease: boolean;
}

export interface SorobanOutboxClaimRejection {
  claimed: false;
  reasonCode:
    | typeof SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND
    | typeof SOROBAN_OUTBOX_REASON_CODES.ALREADY_CLAIMED
    | typeof SOROBAN_OUTBOX_REASON_CODES.ALREADY_COMPLETED
    | typeof SOROBAN_OUTBOX_REASON_CODES.NOT_CLAIMABLE;
}

export type SorobanOutboxClaimResult =
  | SorobanOutboxClaimGrant
  | SorobanOutboxClaimRejection;

export interface ClaimNextSorobanOutboxOptions extends ClaimSorobanOutboxOptions {
  batchSize?: number;
}

export type SorobanOutboxLeaseMutationResult =
  | { ok: true; entry: SorobanOutboxEntry }
  | {
      ok: false;
      reasonCode:
        | typeof SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND
        | typeof SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN;
    };

export interface DrainSorobanOutboxOptions {
  workerId: string;
  sink: (
    entry: SorobanOutboxEntry,
    grant: SorobanOutboxClaimGrant,
  ) => Promise<void> | void;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface DrainSorobanOutboxResult {
  workerId: string;
  claimedCount: number;
  deliveredCount: number;
  failedCount: number;
  releasedCount: number;
  staleLeaseCount: number;
  reclaimedCount: number;
}

export interface EnqueueSorobanOutboxOptions {
  /** Optional idempotency key so retries do not duplicate the mirror. */
  idempotencyKey?: string;
  /** Optional sink override, primarily for tests. */
  sink?: SorobanOutboxSink;
  /** Owning maintainer org. Present => persist via Prisma (production). */
  maintainerOrgId?: string;
  /** Outbox action discriminator. Defaults to "register". */
  action?: string;
}

export type SorobanOutboxSink = (
  entry: SorobanOutboxEntry,
) => Promise<void> | void;

const outbox = new Map<string, SorobanOutboxEntry>();

let sink: SorobanOutboxSink | undefined;

/**
 * Register the process-wide sink used to deliver outbox entries to Soroban.
 * The worker (scripts/worker.mjs) drains the same store via the exported
 * helpers below; keeping a single sink avoids a parallel subsystem.
 */
export function setSorobanOutboxSink(next?: SorobanOutboxSink): void {
  sink = next;
}

export function resolveOutboxLeaseMs(override?: number): number {
  if (override !== undefined) {
    if (
      typeof override !== "number" ||
      !Number.isFinite(override) ||
      override < MIN_OUTBOX_LEASE_MS ||
      override > MAX_OUTBOX_LEASE_MS
    ) {
      throw new SorobanOutboxError(
        SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_MS,
        `Invalid outbox leaseMs: must be a finite number between ${MIN_OUTBOX_LEASE_MS} and ${MAX_OUTBOX_LEASE_MS}`,
      );
    }
    return Math.floor(override);
  }

  const rawEnv = process.env.SOROBAN_OUTBOX_LEASE_MS?.trim();
  if (!rawEnv) {
    return DEFAULT_OUTBOX_LEASE_MS;
  }

  const parsed = Number(rawEnv);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_OUTBOX_LEASE_MS ||
    parsed > MAX_OUTBOX_LEASE_MS
  ) {
    throw new SorobanOutboxError(
      SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_MS,
      `Invalid SOROBAN_OUTBOX_LEASE_MS: must be a finite number between ${MIN_OUTBOX_LEASE_MS} and ${MAX_OUTBOX_LEASE_MS}`,
    );
  }
  return Math.floor(parsed);
}

function validateWorkerId(workerId: string): string {
  const trimmed = typeof workerId === "string" ? workerId.trim() : "";
  if (!trimmed || trimmed.length > MAX_OUTBOX_WORKER_ID_LENGTH) {
    throw new SorobanOutboxError(
      SOROBAN_OUTBOX_REASON_CODES.INVALID_WORKER_ID,
      `Invalid workerId: must be a non-empty string of at most ${MAX_OUTBOX_WORKER_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validateLeaseToken(leaseToken: string): string {
  const trimmed = typeof leaseToken === "string" ? leaseToken.trim() : "";
  if (!trimmed) {
    throw new SorobanOutboxError(
      SOROBAN_OUTBOX_REASON_CODES.INVALID_LEASE_TOKEN,
      "Invalid leaseToken: must be a non-empty string",
    );
  }
  return trimmed;
}

function validateBatchSize(batchSize: number): number {
  if (
    typeof batchSize !== "number" ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_OUTBOX_BATCH_SIZE
  ) {
    throw new SorobanOutboxError(
      SOROBAN_OUTBOX_REASON_CODES.INVALID_BATCH_SIZE,
      `Invalid batchSize: must be an integer between 1 and ${MAX_OUTBOX_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

function clearLeaseMetadata(entry: SorobanOutboxEntry): void {
  delete entry.leaseOwner;
  delete entry.leaseToken;
  delete entry.leaseExpiresAt;
}

function isLeaseActive(entry: SorobanOutboxEntry, nowMs: number): boolean {
  if (!entry.leaseExpiresAt) return false;
  const expiresMs = Date.parse(entry.leaseExpiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

/**
 * Enqueue a Soroban mirror payload for asynchronous delivery.
 *
 * Failures are surfaced (thrown) rather than swallowed so callers such as the
 * register route can report a real error instead of a silent no-op.
 */
export async function enqueueSorobanOutbox(
  payload: unknown,
  options: EnqueueSorobanOutboxOptions = {},
): Promise<SorobanOutboxEntry> {
  if (payload === undefined || payload === null) {
    throw new SorobanOutboxError(
      SOROBAN_OUTBOX_REASON_CODES.INVALID_PAYLOAD,
      "enqueueSorobanOutbox: payload is required",
    );
  }

  const activeSink = options.sink ?? sink;

  // Production path: no sink configured, org present => persist for the worker.
  if (!activeSink && options.maintainerOrgId) {
    const created = await prisma.sorobanOutbox.create({
      data: {
        maintainerOrgId: options.maintainerOrgId,
        action: options.action ?? "register",
        payload: payload as Prisma.InputJsonValue,
        status: "PENDING",
        ...(options.idempotencyKey
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      },
    });
    return created as unknown as SorobanOutboxEntry;
  }

  // In-memory path (tests, local worker loop, or legacy callers).
  const now = new Date().toISOString();
  const id = options.idempotencyKey ?? randomUUID();

  const existing = outbox.get(id);
  if (existing && existing.status !== "FAILED") {
    return existing;
  }

  const entry: SorobanOutboxEntry = {
    id,
    payload,
    status: "PENDING",
    attempts: existing?.attempts ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  outbox.set(id, entry);

  if (activeSink) {
    try {
      // Pass the live entry: the sink observes it as-enqueued (PENDING) and
      // callers holding the reference see the terminal state assigned below.
      // (A snapshot copy would break identity between the delivered object
      // and the stored entry, which the in-memory contract tests pin.)
      await activeSink(entry);
      entry.status = "COMPLETED";
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
    } catch (error) {
      entry.status = "FAILED";
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
      throw error;
    }
  }

  return entry;
}

/**
 * Atomically claim an in-memory outbox entry with a time-bounded lease and a
 * unique fencing token. Only one concurrent worker can hold an active lease
 * for a given entry at a time; expired leases may be reclaimed.
 */
export function claimSorobanOutboxEntry(
  id: string,
  options: ClaimSorobanOutboxOptions,
): SorobanOutboxClaimResult {
  const workerId = validateWorkerId(options.workerId);
  const leaseMs = resolveOutboxLeaseMs(options.leaseMs);
  const nowMs = options.now ?? Date.now();

  const entry = outbox.get(id);
  if (!entry) {
    return {
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND,
    };
  }

  if (entry.status === "COMPLETED") {
    return {
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ALREADY_COMPLETED,
    };
  }

  if (entry.status === "FAILED" && !options.includeFailed) {
    return {
      claimed: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.NOT_CLAIMABLE,
    };
  }

  let reclaimedExpiredLease = false;
  if (entry.status === "PROCESSING") {
    if (isLeaseActive(entry, nowMs)) {
      return {
        claimed: false,
        reasonCode: SOROBAN_OUTBOX_REASON_CODES.ALREADY_CLAIMED,
      };
    }
    reclaimedExpiredLease = true;
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
  entry.status = "PROCESSING";
  entry.leaseOwner = workerId;
  entry.leaseToken = leaseToken;
  entry.leaseExpiresAt = leaseExpiresAt;
  entry.updatedAt = new Date(nowMs).toISOString();
  outbox.set(id, entry);

  return {
    claimed: true,
    entry,
    leaseToken,
    leaseExpiresAt,
    reclaimedExpiredLease,
  };
}

/**
 * Atomically claim up to `batchSize` eligible in-memory outbox entries in
 * insertion order.
 */
export function claimNextSorobanOutboxEntries(
  options: ClaimNextSorobanOutboxOptions,
): SorobanOutboxClaimGrant[] {
  const workerId = validateWorkerId(options.workerId);
  const leaseMs = resolveOutboxLeaseMs(options.leaseMs);
  const batchSize = validateBatchSize(options.batchSize ?? 10);
  const nowMs = options.now ?? Date.now();

  const grants: SorobanOutboxClaimGrant[] = [];
  for (const entry of outbox.values()) {
    if (grants.length >= batchSize) break;
    const result = claimSorobanOutboxEntry(entry.id, {
      workerId,
      leaseMs,
      now: nowMs,
      includeFailed: options.includeFailed,
    });
    if (result.claimed) {
      grants.push(result);
    }
  }
  return grants;
}

/**
 * Finalize a claimed entry as `COMPLETED` only if the caller still presents
 * the active, unexpired fencing token.
 */
export function completeSorobanOutboxClaim(
  id: string,
  leaseToken: string,
  options: { now?: number } = {},
): SorobanOutboxLeaseMutationResult {
  const token = validateLeaseToken(leaseToken);
  const nowMs = options.now ?? Date.now();
  const entry = outbox.get(id);
  if (!entry) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND,
    };
  }

  if (
    entry.status !== "PROCESSING" ||
    entry.leaseToken !== token ||
    !isLeaseActive(entry, nowMs)
  ) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    };
  }

  entry.status = "COMPLETED";
  delete entry.lastError;
  clearLeaseMetadata(entry);
  entry.updatedAt = new Date(nowMs).toISOString();
  outbox.set(id, entry);
  return { ok: true, entry };
}

/**
 * Record a delivery failure for a claimed entry only if the caller still
 * holds the active, unexpired fencing token.
 */
export function failSorobanOutboxClaim(
  id: string,
  leaseToken: string,
  error: unknown,
  options: { requeue?: boolean; now?: number } = {},
): SorobanOutboxLeaseMutationResult {
  const token = validateLeaseToken(leaseToken);
  const nowMs = options.now ?? Date.now();
  const entry = outbox.get(id);
  if (!entry) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND,
    };
  }

  if (
    entry.status !== "PROCESSING" ||
    entry.leaseToken !== token ||
    !isLeaseActive(entry, nowMs)
  ) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    };
  }

  entry.attempts += 1;
  entry.lastError = error instanceof Error ? error.message : String(error);
  entry.status = options.requeue ? "PENDING" : "FAILED";
  clearLeaseMetadata(entry);
  entry.updatedAt = new Date(nowMs).toISOString();
  outbox.set(id, entry);
  return { ok: true, entry };
}

/**
 * Gracefully release an active lease back to `PENDING` without incrementing
 * `attempts` (used when a worker is cancelled, paused, or frozen mid-flight).
 */
export function releaseSorobanOutboxClaim(
  id: string,
  leaseToken: string,
  options: { now?: number } = {},
): SorobanOutboxLeaseMutationResult {
  const token = validateLeaseToken(leaseToken);
  const nowMs = options.now ?? Date.now();
  const entry = outbox.get(id);
  if (!entry) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.ENTRY_NOT_FOUND,
    };
  }

  if (
    entry.status !== "PROCESSING" ||
    entry.leaseToken !== token ||
    !isLeaseActive(entry, nowMs)
  ) {
    return {
      ok: false,
      reasonCode: SOROBAN_OUTBOX_REASON_CODES.STALE_LEASE_TOKEN,
    };
  }

  entry.status = "PENDING";
  clearLeaseMetadata(entry);
  entry.updatedAt = new Date(nowMs).toISOString();
  outbox.set(id, entry);
  return { ok: true, entry };
}

/**
 * Drain eligible in-memory outbox entries for a single worker tick using
 * atomic leases and fencing tokens so concurrent workers do not double-deliver.
 */
export async function drainSorobanOutboxWithLease(
  options: DrainSorobanOutboxOptions,
): Promise<DrainSorobanOutboxResult> {
  const workerId = validateWorkerId(options.workerId);
  const leaseMs = resolveOutboxLeaseMs(options.leaseMs);
  const batchSize = validateBatchSize(options.batchSize ?? 10);
  const maxAttempts = options.maxAttempts ?? 5;
  const nowFn = options.now ?? Date.now;

  if (options.signal?.aborted) {
    return {
      workerId,
      claimedCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      releasedCount: 0,
      staleLeaseCount: 0,
      reclaimedCount: 0,
    };
  }

  const grants = claimNextSorobanOutboxEntries({
    workerId,
    leaseMs,
    batchSize,
    now: nowFn(),
  });

  let deliveredCount = 0;
  let failedCount = 0;
  let releasedCount = 0;
  let staleLeaseCount = 0;
  let reclaimedCount = 0;

  for (const grant of grants) {
    if (grant.reclaimedExpiredLease) {
      reclaimedCount++;
    }

    if (options.signal?.aborted) {
      const released = releaseSorobanOutboxClaim(
        grant.entry.id,
        grant.leaseToken,
        { now: nowFn() },
      );
      if (released.ok) {
        releasedCount++;
      } else {
        staleLeaseCount++;
      }
      continue;
    }

    try {
      await options.sink(grant.entry, grant);
      const completed = completeSorobanOutboxClaim(
        grant.entry.id,
        grant.leaseToken,
        { now: nowFn() },
      );
      if (completed.ok) {
        deliveredCount++;
      } else {
        staleLeaseCount++;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        const released = releaseSorobanOutboxClaim(
          grant.entry.id,
          grant.leaseToken,
          { now: nowFn() },
        );
        if (released.ok) {
          releasedCount++;
        } else {
          staleLeaseCount++;
        }
      } else {
        const requeue = grant.entry.attempts + 1 < maxAttempts;
        const failed = failSorobanOutboxClaim(
          grant.entry.id,
          grant.leaseToken,
          error,
          { requeue, now: nowFn() },
        );
        if (failed.ok) {
          failedCount++;
        } else {
          staleLeaseCount++;
        }
      }
    }
  }

  return {
    workerId,
    claimedCount: grants.length,
    deliveredCount,
    failedCount,
    releasedCount,
    staleLeaseCount,
    reclaimedCount,
  };
}

export function getSorobanOutboxEntry(
  id: string,
): SorobanOutboxEntry | undefined {
  return outbox.get(id);
}

export function listSorobanOutbox(): SorobanOutboxEntry[] {
  return Array.from(outbox.values());
}

export function clearSorobanOutbox(): void {
  outbox.clear();
}

/**
 * Outbox lag snapshot consumed by the readiness deep health probe
 * (Issue #772).
 *
 * `oldestPendingAgeMs` is the age of the oldest still-undelivered entry
 * (`PENDING` / `PROCESSING`), or `0` when the outbox is drained. `pending`
 * counts undelivered entries and `failed` counts entries whose last delivery
 * attempt threw. The probe in `src/lib/health.ts` compares
 * `oldestPendingAgeMs` against a configurable threshold to surface silent
 * outbox lag that would desync Wave on-chain state from the UI.
 */
export interface SorobanOutboxLagSnapshot {
  pending: number;
  failed: number;
  oldestPendingAgeMs: number;
}

/**
 * Compute the current outbox lag from the in-memory store.
 *
 * Read-only and idempotent: repeated calls never mutate entries. Throws are
 * not swallowed here — the caller (health probe) is responsible for mapping
 * a query failure to a stable reason code.
 */
export function getSorobanOutboxLag(
  now: number = Date.now(),
): SorobanOutboxLagSnapshot {
  let pending = 0;
  let failed = 0;
  let oldestPendingAgeMs = 0;

  for (const entry of outbox.values()) {
    if (entry.status === "PENDING" || entry.status === "PROCESSING") {
      pending += 1;
      const createdAt = Date.parse(entry.createdAt);
      if (!Number.isNaN(createdAt)) {
        const age = now - createdAt;
        if (age > oldestPendingAgeMs) {
          oldestPendingAgeMs = age;
        }
      }
    } else if (entry.status === "FAILED") {
      failed += 1;
    }
  }

  return { pending, failed, oldestPendingAgeMs };
}

/** Default max delivery attempts (alias used by retry-budget callers). */
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Returns `true` when an entry has been parked as a poison message: it is in
 * the `FAILED` state **and** has exhausted its delivery budget
 * (`attempts >= maxAttempts`). The entry will not be retried by
 * `enqueueSorobanOutbox` until an operator resets it.
 */
export function isEntryParked(entry: SorobanOutboxEntry): boolean {
  const budget = entry.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS;
  return entry.status === "FAILED" && entry.attempts >= budget;
}

/**
 * Enumerate all entries that are currently parked as poison messages.
 * These are `FAILED` entries whose delivery budget has been exhausted.
 * Surfaced so an operator dashboard or monitoring cron can page on them.
 */
export function listPoisonedEntries(): SorobanOutboxEntry[] {
  return listSorobanOutbox().filter(isEntryParked);
}

/**
 * In-memory DLQ metrics: counts by status across all entries in the
 * process-local store. The production Prisma path exposes equivalent counts
 * via `getSorobanOutboxMetrics` in `soroban-outbox-worker.ts`.
 */
export interface InMemoryOutboxMetrics {
  total: number;
  pending: number;
  completed: number;
  failed: number;
  /** Entries that have exhausted their retry budget (poison messages). */
  parked: number;
}

export function getInMemoryOutboxMetrics(): InMemoryOutboxMetrics {
  let pending = 0;
  let completed = 0;
  let failed = 0;
  let parked = 0;

  for (const entry of listSorobanOutbox()) {
    switch (entry.status) {
      case "PENDING":
      case "PROCESSING":
        pending++;
        break;
      case "COMPLETED":
        completed++;
        break;
      case "FAILED":
        failed++;
        if (isEntryParked(entry)) parked++;
        break;
    }
  }

  return { total: listSorobanOutbox().length, pending, completed, failed, parked };
}
