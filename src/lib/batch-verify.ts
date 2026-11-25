/**
 * Batch verification utilities for dashboard.
 * Enables efficient bulk verification of contributor readiness.
 */

export interface VerificationCheckResult {
  username: string;
  stellar_address: string;
  status: 'ready' | 'low_reserve' | 'not_ready' | 'error';
  error_message?: string;
  checks: {
    funded: boolean;
    trustline: boolean;
    reserve: boolean;
  };
  xlm_balance?: string;
  last_checked?: Date;
}

export interface BatchVerificationOptions {
  /**
   * Maximum concurrent verification requests
   */
  concurrency?: number;
  /**
   * Timeout per verification in milliseconds
   */
  timeout?: number;
  /**
   * Whether to skip already verified accounts
   */
  skipVerified?: boolean;
  /**
   * Minimum XLM reserve requirement
   */
  minXlmReserve?: number;
  jobId?: string;
  onProgress?: (event: BatchVerificationProgressEvent) => void | Promise<void>;
}

export interface BatchVerificationProgressEvent {
  type: "progress";
  jobId: string;
  processed: number;
  total: number;
  errors: number;
  done: boolean;
  updatedAt: string;
}

export interface BatchProgressEmitter {
  readonly snapshot: BatchVerificationProgress;
  record(result: VerificationCheckResult): void;
  finish(): void;
  flush(): Promise<void>;
}

/**
 * Serializable snapshot of batch-verify progress.
 *
 * Persisted so that SSE clients reconnecting mid-job can resume from the
 * last known state instead of resetting progress to zero.
 */
export interface BatchVerificationProgress {
  /** Stable identifier for the batch job. */
  jobId: string;
  /** Total number of verifications in the job. */
  total: number;
  /** Number of verifications completed so far. */
  completed: number;
  /** Results collected so far (in completion order). */
  results: VerificationCheckResult[];
  /** Whether the job has finished (successfully or with errors). */
  done: boolean;
  /** ISO timestamp of the last progress update. */
  updatedAt: string;
}

/**
 * Default maximum number of concurrent verifications per batch job.
 *
 * Bounds the number of in-flight verify calls so a single batch cannot
 * starve other Wave org workloads. Overridable per call via
 * `BatchVerificationOptions.concurrency` or globally via the
 * `BATCH_VERIFY_MAX_CONCURRENCY` env var.
 */
export const DEFAULT_BATCH_VERIFY_CONCURRENCY = 5;

/**
 * Hard upper bound on concurrency. Values above this are rejected so a
 * misconfigured env var cannot reintroduce unbounded parallelism.
 */
export const MAX_BATCH_VERIFY_CONCURRENCY = 50;

/**
 * Resolve the effective max concurrency for a batch verify job.
 *
 * Precedence: explicit option > `BATCH_VERIFY_MAX_CONCURRENCY` env var >
 * `DEFAULT_BATCH_VERIFY_CONCURRENCY`. Throws a stable error for malformed
 * or out-of-range values so misconfiguration fails loudly instead of
 * silently falling back to unbounded behavior.
 */
export function resolveBatchVerifyConcurrency(
  override?: number,
  env: Record<string, string | undefined> = typeof process !== 'undefined'
    ? process.env
    : {},
): number {
  const raw = override ?? env.BATCH_VERIFY_MAX_CONCURRENCY;

  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_BATCH_VERIFY_CONCURRENCY;
  }

  const value = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Invalid batch verify concurrency: expected an integer >= 1, received ${String(raw)}`,
    );
  }

  if (value > MAX_BATCH_VERIFY_CONCURRENCY) {
    throw new Error(
      `Invalid batch verify concurrency: ${value} exceeds max of ${MAX_BATCH_VERIFY_CONCURRENCY}`,
    );
  }

  return value;
}

/**
 * Execute multiple verification checks with concurrency control.
 *
 * Concurrency is bounded by `resolveBatchVerifyConcurrency` so a single
 * batch cannot monopolize worker slots. When items carry an `orgId`, the
 * queue is drained round-robin across orgs so one org cannot starve the
 * others (fair scheduling).
 */
export async function batchVerify(
  verifications: Array<{
    username: string;
    stellar_address: string;
    orgId?: string;
  }>,
  verifyFn: (address: string) => Promise<VerificationCheckResult>,
  options: BatchVerificationOptions = {},
): Promise<VerificationCheckResult[]> {
  const { timeout = 10_000, jobId = "batch-verify", onProgress } = options;
  const concurrency = resolveBatchVerifyConcurrency(options.concurrency);

  const results: VerificationCheckResult[] = [];
  const queue = buildFairQueue(verifications);
  const emitter = onProgress
    ? createBatchProgressEmitter(jobId, verifications.length, onProgress)
    : null;

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      let result: VerificationCheckResult;
      try {
        const timeoutPromise = new Promise<VerificationCheckResult>((_, reject) =>
          setTimeout(() => reject(new Error('Verification timeout')), timeout),
        );

        result = await Promise.race([
          verifyFn(item.stellar_address),
          timeoutPromise,
        ]);
      } catch (error) {
        result = {
          username: item.username,
          stellar_address: item.stellar_address,
          status: 'error',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          checks: {
            funded: false,
            trustline: false,
            reserve: false,
          },
        };
      }

      results.push(result);
      emitter?.record(result);
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  emitter?.finish();
  await emitter?.flush();

  return results;
}

/**
 * Build a fair, round-robin ordered queue from a batch of verifications.
 *
 * Items are grouped by `orgId` (items without an org share a single bucket)
 * and interleaved one-per-org per round so a single org with a large batch
 * cannot monopolize worker slots ahead of other orgs. Within an org, the
 * original input order is preserved.
 */
export function buildFairQueue<T extends { orgId?: string }>(items: T[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = item.orgId ?? '__default__';
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  const ordered: T[] = [];
  const groups = Array.from(buckets.values());
  let remaining = items.length;
  let index = 0;

  while (remaining > 0) {
    const group = groups[index % groups.length];
    const next = group.shift();
    if (next !== undefined) {
      ordered.push(next);
      remaining -= 1;
    }
    index += 1;
  }

  return ordered;
}

/**
 * Create an initial progress snapshot for a batch-verify job.
 */
export function createBatchProgress(
  jobId: string,
  total: number,
): BatchVerificationProgress {
  return {
    jobId,
    total,
    completed: 0,
    results: [],
    done: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record a completed verification into a progress snapshot.
 *
 * Returns a new snapshot (does not mutate the input) so callers can safely
 * persist and broadcast it to reconnecting SSE clients.
 */
export function recordBatchProgress(
  progress: BatchVerificationProgress,
  result: VerificationCheckResult,
): BatchVerificationProgress {
  const results = [...progress.results, result];
  const completed = results.length;
  return {
    ...progress,
    results,
    completed,
    done: completed >= progress.total,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark a progress snapshot as finished.
 */
export function finalizeBatchProgress(
  progress: BatchVerificationProgress,
): BatchVerificationProgress {
  return {
    ...progress,
    done: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a persisted progress snapshot (e.g. loaded from storage after a
 * reconnect). Returns a clear, stable error for malformed input.
 */
export function parseBatchProgress(raw: unknown): BatchVerificationProgress {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid batch progress: expected an object');
  }

  const candidate = raw as Partial<BatchVerificationProgress>;

  if (typeof candidate.jobId !== 'string' || candidate.jobId.length === 0) {
    throw new Error('Invalid batch progress: missing jobId');
  }
  if (typeof candidate.total !== 'number' || candidate.total < 0) {
    throw new Error('Invalid batch progress: invalid total');
  }
  if (!Array.isArray(candidate.results)) {
    throw new Error('Invalid batch progress: missing results');
  }

  const results = candidate.results as VerificationCheckResult[];
  const completed =
    typeof candidate.completed === 'number' ? candidate.completed : results.length;

  return {
    jobId: candidate.jobId,
    total: candidate.total,
    completed,
    results,
    done: candidate.done === true || completed >= candidate.total,
    updatedAt:
      typeof candidate.updatedAt === 'string'
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
}

export function toBatchProgressEvent(
  progress: BatchVerificationProgress,
): BatchVerificationProgressEvent {
  return {
    type: "progress",
    jobId: progress.jobId,
    processed: progress.completed,
    total: progress.total,
    errors: progress.results.filter((result) => result.status === 'error').length,
    done: progress.done,
    updatedAt: progress.updatedAt,
  };
}

export function parseJobProgressEvent(raw: unknown): BatchVerificationProgressEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const candidate = raw as Partial<BatchVerificationProgressEvent>;
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

  if (
    candidate.type !== 'progress' ||
    typeof candidate.jobId !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !isCount(candidate.processed) ||
    !isCount(candidate.total) ||
    !isCount(candidate.errors) ||
    typeof candidate.done !== 'boolean'
  ) {
    return null;
  }

  return {
    type: 'progress',
    jobId: candidate.jobId,
    processed: candidate.processed,
    total: candidate.total,
    errors: candidate.errors,
    done: candidate.done,
    updatedAt: candidate.updatedAt,
  };
}

function nextProgressTimestamp(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(
    Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0),
  ).toISOString();
}

export function createBatchProgressEmitter(
  jobId: string,
  total: number,
  onSnapshot: (event: BatchVerificationProgressEvent) => void | Promise<void>,
): BatchProgressEmitter {
  let snapshot = createBatchProgress(jobId, total);
  let pending: Promise<void> = Promise.resolve();

  const emit = (next: BatchVerificationProgress) => {
    const stamped: BatchVerificationProgress = {
      ...next,
      updatedAt: nextProgressTimestamp(next.updatedAt),
    };
    snapshot = stamped;
    pending = pending.then(() => onSnapshot(toBatchProgressEvent(stamped)));
  };

  return {
    get snapshot() {
      return snapshot;
    },
    record(result: VerificationCheckResult) {
      emit(recordBatchProgress(snapshot, result));
    },
    finish() {
      emit(finalizeBatchProgress(snapshot));
    },
    async flush() {
      await pending;
    },
  };
}
