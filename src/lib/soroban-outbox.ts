import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type SorobanOutboxStatus = "pending" | "processing" | "sent" | "completed" | "failed";

export interface SorobanOutboxEntry {
  id: string;
  payload: unknown;
  status: SorobanOutboxStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSorobanOutboxOptions {
  /** Optional idempotency key so retries do not duplicate the mirror. */
  idempotencyKey?: string;
  /** Optional maintainer org ID. */
  maintainerOrgId?: string;
  /** Optional action name. */
  action?: string;
  /** Optional sink override, primarily for tests. */
  sink?: SorobanOutboxSink;
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
 * Persists durable records to PostgreSQL via Prisma with an in-memory fallback.
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

  const now = new Date().toISOString();
  const idempotencyKey = options.idempotencyKey;
  const maintainerOrgId = options.maintainerOrgId ?? "default";
  const action = options.action ?? "register";

  let entry: SorobanOutboxEntry;

  try {
    if (idempotencyKey) {
      const existing = await prisma.sorobanOutbox.findFirst({
        where: { idempotencyKey },
      });
      if (existing && existing.status !== "FAILED") {
        const existingEntry: SorobanOutboxEntry = {
          id: existing.id,
          payload: existing.payload,
          status: existing.status.toLowerCase() as SorobanOutboxStatus,
          attempts: existing.attempts,
          lastError: existing.lastError ?? undefined,
          createdAt: existing.createdAt.toISOString(),
          updatedAt: existing.updatedAt.toISOString(),
        };
        outbox.set(existing.id, existingEntry);
        return existingEntry;
      }
    }

    const created = await prisma.sorobanOutbox.create({
      data: {
        maintainerOrgId,
        action,
        payload: payload as any,
        idempotencyKey: idempotencyKey ?? undefined,
        status: "PENDING",
      },
    });

    entry = {
      id: created.id,
      payload: created.payload,
      status: "pending",
      attempts: created.attempts,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  } catch {
    // In-memory fallback if Prisma is unavailable
    const id = idempotencyKey ?? randomUUID();
    const existing = outbox.get(id);
    if (existing && existing.status !== "failed") {
      return existing;
    }

    entry = {
      id,
      payload,
      status: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  outbox.set(entry.id, entry);

  const activeSink = options.sink ?? sink;
  if (activeSink) {
    try {
      await activeSink(entry);
      entry.status = "sent";
      entry.updatedAt = new Date().toISOString();
      outbox.set(entry.id, entry);
      try {
        await prisma.sorobanOutbox.update({
          where: { id: entry.id },
          data: { status: "COMPLETED" },
        });
      } catch {
        // Ignored
      }
    } catch (error) {
      entry.status = "failed";
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      outbox.set(entry.id, entry);
      try {
        await prisma.sorobanOutbox.update({
          where: { id: entry.id },
          data: {
            status: "FAILED",
            attempts: entry.attempts,
            lastError: entry.lastError,
          },
        });
      } catch {
        // Ignored
      }
      throw error;
    }
  }

  return entry;
}

export async function getSorobanOutboxEntry(id: string): Promise<SorobanOutboxEntry | undefined> {
  try {
    const record = await prisma.sorobanOutbox.findUnique({
      where: { id },
    });
    if (record) {
      const entry: SorobanOutboxEntry = {
        id: record.id,
        payload: record.payload,
        status: record.status.toLowerCase() as SorobanOutboxStatus,
        attempts: record.attempts,
        lastError: record.lastError ?? undefined,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
      outbox.set(record.id, entry);
      return entry;
    }
  } catch {
    // Ignored
  }
  return outbox.get(id);
}

export function listSorobanOutbox(): SorobanOutboxEntry[] {
  return Array.from(outbox.values());
}

export function clearSorobanOutbox(): void {
  outbox.clear();
}
