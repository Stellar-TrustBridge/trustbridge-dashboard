import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Unified Soroban outbox adapter (Issue #488 / #199).
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
 * **Retry budget and poison-message parking:**
 * Each entry carries a `maxAttempts` budget (default: 5). Once `attempts`
 * reaches `maxAttempts` the entry is **parked** — its status stays `FAILED`
 * and re-enqueue calls are silently rejected (the entry is returned as-is so
 * callers can observe the parked state without crashing). `listPoisonedEntries()`
 * enumerates all parked entries so an operator dashboard or cron can surface
 * them. `isEntryParked()` is the single predicate callers use to check that
 * boundary.
 *
 * Statuses are UPPERCASE to match the persisted rows the worker writes
 * (`PENDING` / `COMPLETED` / `FAILED`).
 */
export type SorobanOutboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

/**
 * Default maximum delivery attempts before an entry is parked as a
 * poison message. Matches the `maxAttempts` default in `processSorobanOutbox`.
 */
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 5;

export interface SorobanOutboxEntry {
  id: string;
  payload: unknown;
  status: SorobanOutboxStatus;
  attempts: number;
  /**
   * Delivery budget: once `attempts >= maxAttempts` the entry is parked as a
   * poison message and no further delivery is attempted. Defaults to
   * `OUTBOX_DEFAULT_MAX_ATTEMPTS` for new entries.
   */
  maxAttempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
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
  /**
   * Maximum delivery attempts before this entry is parked as a poison message.
   * Defaults to `OUTBOX_DEFAULT_MAX_ATTEMPTS`. Only applied to new entries;
   * re-enqueued failed entries inherit the existing budget.
   */
  maxAttempts?: number;
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

/**
 * Enqueue a Soroban mirror payload for asynchronous delivery.
 *
 * **Retry budget:** when re-enqueuing a previously-failed entry, the call is
 * rejected (entry returned as-is, parked) once `attempts >= maxAttempts`.
 * This prevents infinite retry loops on poison messages. For the production
 * Prisma path, the budget is enforced by `processSorobanOutbox`; for the
 * in-memory path it is enforced here.
 *
 * Failures are surfaced (thrown) rather than swallowed so callers such as the
 * register route can report a real error instead of a silent no-op.
 */
export async function enqueueSorobanOutbox(
  payload: unknown,
  options: EnqueueSorobanOutboxOptions = {},
): Promise<SorobanOutboxEntry> {
  if (payload === undefined || payload === null) {
    throw new Error("enqueueSorobanOutbox: payload is required");
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
      },
    });
    return created as unknown as SorobanOutboxEntry;
  }

  // In-memory path (tests, local worker loop, or legacy callers).
  const now = new Date().toISOString();
  const id = options.idempotencyKey ?? randomUUID();

  const existing = outbox.get(id);

  // If the entry exists and is not FAILED, return it without re-delivering.
  if (existing && existing.status !== "FAILED") {
    return existing;
  }

  // Poison-message gate: a FAILED entry that has exhausted its budget is
  // parked — return it as-is so callers can observe the state.
  if (existing && isEntryParked(existing)) {
    return existing;
  }

  const budget = existing?.maxAttempts ?? options.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS;

  const entry: SorobanOutboxEntry = {
    id,
    payload,
    status: "PENDING",
    attempts: existing?.attempts ?? 0,
    maxAttempts: budget,
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
 * Returns `true` when an entry has been parked as a poison message: it is in
 * the `FAILED` state **and** has exhausted its delivery budget
 * (`attempts >= maxAttempts`). The entry will not be retried by
 * `enqueueSorobanOutbox` until an operator resets it.
 */
export function isEntryParked(entry: SorobanOutboxEntry): boolean {
  return entry.status === "FAILED" && entry.attempts >= entry.maxAttempts;
}

/**
 * Enumerate all entries that are currently parked as poison messages.
 * These are `FAILED` entries whose delivery budget has been exhausted.
 * Surfaced so an operator dashboard or monitoring cron can page on them.
 */
export function listPoisonedEntries(): SorobanOutboxEntry[] {
  return Array.from(outbox.values()).filter(isEntryParked);
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

  for (const entry of outbox.values()) {
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

  return { total: outbox.size, pending, completed, failed, parked };
}
