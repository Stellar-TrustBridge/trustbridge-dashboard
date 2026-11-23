/**
 * Small, dependency-free retry helpers.
 *
 * Pure and isomorphic (no `server-only`, no stellar-sdk) so they can be unit
 * tested and reused by any module that talks to a flaky upstream such as the
 * Stellar Horizon API, the Soroban outbox worker, or the check API client.
 *
 * Two cooperating exports:
 *
 * - {@link computeJitteredDelay} — the single pure place where the delay for a
 *   given attempt is computed. Shared by {@link withRetry} and by the outbox
 *   worker / check client so every caller uses the same bounded, full-jitter
 *   schedule (no parallel ad-hoc backoff formulas).
 * - {@link withRetry} — run `fn` retrying on thrown failures.
 */

export interface RetryOptions {
  /** Total number of attempts (including the first). Defaults to 3. */
  attempts?: number;
  /** Base delay between attempts, in milliseconds. Defaults to 250ms. */
  delayMs?: number;
  /** Multiply the delay after each failed attempt (exponential backoff). Defaults to 2. */
  backoffFactor?: number;
  /**
   * Upper bound (ceiling), in milliseconds, on the delay between any two
   * attempts. The exponential growth never exceeds this value, so a long
   * retry chain cannot stall delivery for an unbounded time. Defaults to no
   * cap (`Infinity`).
   */
  maxDelayMs?: number;
  /**
   * When `true`, apply **full jitter**: the wait is a uniform random value in
   * `[0, cap]` where `cap = min(maxDelayMs, delayMs * backoffFactor^(attempt-1))`.
   * Full jitter spreads retries from many independent callers so a transient
   * outage is not retried by everyone at the exact same instant. Defaults to
   * `false` (deterministic exponential backoff) to preserve prior behavior for
   * existing callers.
   */
  jitter?: boolean;
  /**
   * Decide whether a thrown error is worth retrying. Return `false` to fail
   * fast (e.g. a 404 that will never succeed). Defaults to retrying everything.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter tests. Defaults to `Math.random`. */
  random?: () => number;
}

export interface JitteredDelayOptions {
  /** Base delay, in milliseconds. Defaults to 250ms. */
  delayMs?: number;
  /** Exponential multiplier per attempt. Defaults to 2. */
  backoffFactor?: number;
  /** Ceiling on the computed delay, in milliseconds. Defaults to no cap. */
  maxDelayMs?: number;
  /** When `true`, return a full-jitter random value in `[0, cap]`. */
  jitter?: boolean;
  /** Injectable RNG for tests. Defaults to `Math.random`. */
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pure delay computation shared by the outbox worker and the check client.
 *
 * `attempt` is 1-indexed: the delay computed for `attempt: 1` is the wait
 * before the *second* attempt (i.e. after the first failure). Returns `0` for
 * `attempt < 1` and for a non-positive base.
 *
 * Without jitter the result is the capped exponential growth:
 *   `min(maxDelayMs, delayMs * backoffFactor^(attempt - 1))`.
 *
 * With jitter (`jitter: true`) the result is a uniform random integer in
 * `[0, cap]` (full jitter), using the injected `random` (default `Math.random`).
 * The ceiling guarantees the wait never exceeds `maxDelayMs`, which is what
 * bounds the outbox delivery retry budget.
 */
export function computeJitteredDelay(
  attempt: number,
  options: JitteredDelayOptions = {},
): number {
  const {
    delayMs = 250,
    backoffFactor = 2,
    maxDelayMs = Number.POSITIVE_INFINITY,
    jitter = false,
    random = Math.random,
  } = options;

  if (attempt < 1 || delayMs <= 0 || backoffFactor <= 0) return 0;

  const raw = delayMs * Math.pow(backoffFactor, attempt - 1);
  const cap = maxDelayMs > 0 ? Math.min(maxDelayMs, raw) : raw;

  if (!jitter) return cap;

  // Full jitter: a uniform random wait in [0, cap]. Spread across callers so
  // a transient outage is not retried by everyone at once. `Math.floor` keeps
  // the value an integer number of milliseconds.
  return Math.floor(random() * cap);
}

/**
 * Run `fn`, retrying on failure with (optionally jittered) exponential backoff.
 * Throws the last error once all attempts are exhausted.
 *
 * The delay between attempts is computed by {@link computeJitteredDelay}, so
 * the ceiling (`maxDelayMs`) and jitter behavior are identical to callers that
 * use that helper directly (e.g. the outbox worker scheduling `nextAttemptAt`).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    attempts = 3,
    delayMs = 250,
    backoffFactor = 2,
    maxDelayMs = Number.POSITIVE_INFINITY,
    jitter = false,
    shouldRetry = () => true,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  const totalAttempts = Math.max(1, Math.floor(attempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === totalAttempts;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }

      const wait = computeJitteredDelay(attempt, {
        delayMs,
        backoffFactor,
        maxDelayMs,
        jitter,
        random,
      });
      if (wait > 0) await sleep(wait);
    }
  }

  // Unreachable in practice — the loop either returns or throws.
  throw lastError;
}
