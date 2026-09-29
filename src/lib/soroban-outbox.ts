import { randomUUID } from "crypto";

export type SorobanOutboxStatus = "pending" | "processing" | "sent" | "failed";

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
  const id = options.idempotencyKey ?? randomUUID();

  const existing = outbox.get(id);
  if (existing && existing.status !== "failed") {
    return existing;
  }

  const entry: SorobanOutboxEntry = {
    id,
    payload,
    status: "pending",
    attempts: existing?.attempts ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  outbox.set(id, entry);

  const activeSink = options.sink ?? sink;
  if (activeSink) {
    try {
      await activeSink(entry);
      entry.status = "sent";
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
    } catch (error) {
      entry.status = "failed";
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
      throw error;
    }
  }

  return entry;
}

export function getSorobanOutboxEntry(id: string): SorobanOutboxEntry | undefined {
  return outbox.get(id);
}

export function listSorobanOutbox(): SorobanOutboxEntry[] {
  return Array.from(outbox.values());
}

export function clearSorobanOutbox(): void {
  outbox.clear();
}
