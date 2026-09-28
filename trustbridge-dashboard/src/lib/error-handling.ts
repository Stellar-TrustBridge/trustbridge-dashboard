/**
 * Error handling helpers.
 *
 * Provides user-facing copy for known error classes and a lightweight
 * ErrorLogger that records structured, redacted error information.
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface LoggedError {
  name: string;
  message: string;
  severity: ErrorSeverity;
  code?: string;
  context?: Record<string, unknown>;
  cause?: LoggedError;
  timestamp: string;
}

const SENSITIVE_KEY_PATTERN = /(pass(word)?|secret|token|api[-_]?key|authorization|auth|cookie|credential|private[-_]?key)/i;
const REDACTED = '[REDACTED]';

/**
 * Recursively redact sensitive keys from a value so secrets never reach logs.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, seen);
  }
  return result;
}

/**
 * Map an error to stable, user-facing copy.
 */
export function getUserFriendlyMessage(error: unknown): string {
  if (error == null) {
    return 'Something went wrong. Please try again.';
  }

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const code = (error as { code?: string })?.code;

  if (name === 'AbortError') {
    return 'The request was cancelled.';
  }

  if (code === 'UNAUTHORIZED' || code === '401') {
    return 'Your session has expired. Please sign in again.';
  }

  if (code === 'FORBIDDEN' || code === '403') {
    return "You don't have permission to do that.";
  }

  if (code === 'NOT_FOUND' || code === '404') {
    return 'We could not find what you were looking for.';
  }

  if (code === 'NETWORK' || name === 'NetworkError') {
    return 'Network error. Please check your connection and try again.';
  }

  if (code === 'TIMEOUT' || name === 'TimeoutError') {
    return 'The request timed out. Please try again.';
  }

  if (message.trim() === '') {
    return 'Something went wrong. Please try again.';
  }

  return message;
}

/**
 * Classify an error into a severity level.
 */
export function classifySeverity(error: unknown): ErrorSeverity {
  const code = (error as { code?: string })?.code;
  const name = error instanceof Error ? error.name : '';

  if (code === 'UNAUTHORIZED' || code === '401' || code === 'FORBIDDEN' || code === '403') {
    return 'warning';
  }
  if (code === 'NOT_FOUND' || code === '404') {
    return 'info';
  }
  if (name === 'AbortError') {
    return 'info';
  }
  if (code === 'FATAL' || name === 'FatalError') {
    return 'fatal';
  }
  return 'error';
}

/**
 * Records structured, redacted error information.
 */
export class ErrorLogger {
  private readonly entries: LoggedError[] = [];

  log(error: unknown, context?: Record<string, unknown>): LoggedError {
    const entry = this.buildEntry(error, context);
    this.entries.push(entry);
    return entry;
  }

  getEntries(): LoggedError[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }

  private buildEntry(error: unknown, context?: Record<string, unknown>): LoggedError {
    const isError = error instanceof Error;
    const entry: LoggedError = {
      name: isError ? error.name : 'Error',
      message: isError ? error.message : String(error ?? ''),
      severity: classifySeverity(error),
      timestamp: new Date().toISOString(),
    };

    const code = (error as { code?: string })?.code;
    if (code !== undefined) {
      entry.code = code;
    }

    if (context !== undefined) {
      entry.context = redact(context) as Record<string, unknown>;
    }

    if (isError && error.cause !== undefined) {
      entry.cause = this.buildEntry(error.cause);
    }

    return entry;
  }
}
