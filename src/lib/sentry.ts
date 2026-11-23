/**
 * Sentry error tracking integration for TrustBridge Dashboard.
 *
 * This module provides a thin wrapper around Sentry so that:
 *  1. The real `@sentry/nextjs` package can be wired in at deploy time by
 *     setting `NEXT_PUBLIC_SENTRY_DSN` (and optionally `SENTRY_AUTH_TOKEN`
 *     for source-map uploads).
 *  2. Without a DSN the module degrades gracefully — every helper is a no-op —
 *     so local development and CI tests work without installing the SDK.
 *  3. Application code always imports from `@/lib/sentry`, never directly from
 *     `@sentry/nextjs`, keeping the surface area of the Sentry dependency to a
 *     single file.
 *
 * @see docs/SENTRY.md for setup, environment variables, and testing guidance.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SentryScope {
  setTag(key: string, value: string): void;
  setUser(user: { id?: string; username?: string } | null): void;
  setExtra(key: string, value: unknown): void;
  setLevel(level: SentryLevel): void;
}

export type SentryLevel = "debug" | "info" | "warning" | "error" | "fatal";

export interface SentryClient {
  captureException(error: unknown, context?: Record<string, unknown>): string;
  captureMessage(message: string, level?: SentryLevel): string;
  withScope(callback: (scope: SentryScope) => void): void;
  setUser(user: { id?: string; username?: string } | null): void;
  flush(timeout?: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns scrubbed from every string that reaches Sentry.
 *
 * Ordering matters: the more specific GitHub token patterns run before the
 * generic long-hex rule so a `ghp_…` token is labelled as a token rather than
 * as an anonymous secret.
 *
 * These are deliberately conservative. Over-redacting a stack frame costs a
 * little debuggability; under-redacting ships a contributor's wallet address
 * or a maintainer's GitHub token to a third-party service, which is the thing
 * this project cannot take back.
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // GitHub fine-grained PATs: github_pat_<22>_<59>
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted:github-token]" },
  // Classic/OAuth/app tokens: ghp_, gho_, ghu_, ghs_, ghr_
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[redacted:github-token]" },
  // Stellar public keys (G…) and secret seeds (S…). Both are 56-char base32.
  // Secrets must never appear anywhere; public G-addresses are personal data
  // that ties a GitHub identity to an on-chain balance, so they go too.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: "[redacted:stellar-secret]" },
  { pattern: /\bG[A-Z2-7]{55}\b/g, replacement: "[redacted:stellar-address]" },
  // Postgres/other connection strings carrying inline credentials.
  { pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@]+@/gi, replacement: "$1://[redacted:credentials]@" },
  // Authorization header values.
  { pattern: /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "$1 [redacted:token]" },
  // Email addresses.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[redacted:email]" },
];

/** Context keys whose value is dropped wholesale, whatever it looks like. */
const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "sessiontoken",
  "session_token",
  "tokenencryptionkey",
  "token_encryption_key",
]);

/**
 * Context keys whose string values should be **pseudonymized** rather than
 * dropped or passed through raw.
 *
 * - **Username keys**: GitHub handles tie a Sentry event to a real person.
 *   They are pseudonymized so engineers can correlate multiple events to the
 *   same contributor without the raw login appearing in Sentry's UI or exports.
 * - **Address keys**: Stellar G-addresses are financial PII. They are
 *   pseudonymized so payment-flow errors remain debuggable (same pseudonym
 *   across events means same wallet) without revealing the on-chain identity.
 *
 * Key matching is **case-insensitive** and strips underscores/hyphens before
 * matching so `stellarAddress`, `stellar_address`, `StellarAddress`, and
 * `STELLAR-ADDRESS` all hit the same rule.
 */
const USERNAME_KEYS = new Set([
  "githubusername",
  "github_username",
  "username",
  "login",
  "actorusername",
  "actor_username",
  "actorloga",
  "actorlogin",
  "actor_login",
  "githublogin",
  "github_login",
]);

const ADDRESS_KEYS = new Set([
  "stellaraddress",
  "stellar_address",
  "walletaddress",
  "wallet_address",
  "address",
  "stellarwallet",
  "stellar_wallet",
  "fromaddress",
  "from_address",
  "toaddress",
  "to_address",
]);

/** Depth cap, so a cyclic or pathological object can't hang the reporter. */
const MAX_REDACT_DEPTH = 6;

// ---------------------------------------------------------------------------
// Pseudonymization
// ---------------------------------------------------------------------------

/**
 * Produce a stable, non-reversible pseudonym for a user identity or wallet
 * address. The same input always produces the same output within a process
 * and across deploys (SHA-256 is deterministic).
 *
 * Format: `[pseudo:<first 12 hex chars>]` — long enough to distinguish 2^48
 * individuals (~280 trillion) with negligible collision probability; short
 * enough that Sentry's UI does not truncate it.
 *
 * **Non-reversible**: SHA-256 means the original value cannot be recovered
 * from the pseudonym. An engineer who needs to look up a contributor can
 * recompute the pseudonym from their own data to correlate it.
 *
 * **Never throws**: defensive try/catch because this runs inside error
 * reporters; a crash here would mask the original error.
 */
export function pseudonymize(value: string): string {
  if (!value || typeof value !== "string") return "[pseudo:empty]";
  const trimmed = value.trim();
  if (!trimmed) return "[pseudo:empty]";
  try {
    const hex = createHash("sha256")
      .update(trimmed, "utf8")
      .digest("hex")
      .slice(0, 12);
    return `[pseudo:${hex}]`;
  } catch {
    return "[pseudo:error]";
  }
}

// ---------------------------------------------------------------------------
// Field-name normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a context key for set lookups: lowercase and strip underscores,
 * hyphens, and dots so `stellar_address`, `StellarAddress`, and
 * `stellar-address` all match the same entry.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-. ]/g, "");
}

// ---------------------------------------------------------------------------
// User-field and address-field scrubbers
// ---------------------------------------------------------------------------

/**
 * Scrub a flat or nested context bag, pseudonymizing username fields and
 * address fields while keeping every other key intact.
 *
 * This is applied **in addition to** `redactValue` (which handles tokens,
 * secrets, and raw Stellar addresses embedded in string values). The two
 * passes are complementary:
 *
 * - `redactValue` / `redactString` handles patterns inside string values.
 * - `scrubUserFields` / `scrubAddressFields` handle the semantic meaning of
 *   specific context keys so a `{ githubUsername: "alice" }` bag is
 *   pseudonymized even though `"alice"` does not match any pattern rule.
 *
 * Both are applied by `redactContext` and `redactValue` so callers have no
 * per-field responsibilities.
 *
 * @internal Use via `redactContext` or `redactValue`; exported for unit tests.
 */
export function scrubUserFields(
  context: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  if (depth > MAX_REDACT_DEPTH) return { "[max-depth]": true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    const normalized = normalizeKey(key);
    if (USERNAME_KEYS.has(normalized)) {
      out[key] =
        typeof value === "string" && value.trim()
          ? pseudonymize(value)
          : "[pseudo:empty]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = scrubUserFields(value as Record<string, unknown>, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Scrub a flat or nested context bag, pseudonymizing address fields.
 *
 * @internal Use via `redactContext` or `redactValue`; exported for unit tests.
 */
export function scrubAddressFields(
  context: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  if (depth > MAX_REDACT_DEPTH) return { "[max-depth]": true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    const normalized = normalizeKey(key);
    if (ADDRESS_KEYS.has(normalized)) {
      out[key] =
        typeof value === "string" && value.trim()
          ? pseudonymize(value)
          : "[pseudo:empty]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = scrubAddressFields(value as Record<string, unknown>, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Scrub secrets and personal data out of a single string.
 *
 * Exported for tests and for callers that build their own message strings.
 */
export function redactString(input: string): string {
  let output = input;
  for (const { pattern, replacement } of REDACTION_RULES) {
    // Rules are module-level and therefore stateful with the /g flag; reset
    // lastIndex so a previous call can't cause a missed match.
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Recursively redact an arbitrary value: strings are scrubbed, objects are
 * walked, and any key in {@link SENSITIVE_KEYS} is dropped entirely.
 * Username and address fields are pseudonymized via the semantic scrubbers.
 *
 * Errors are converted to a plain object rather than mutated, so the caller's
 * own error instance is never modified by the act of reporting it.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[redacted:max-depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);

      // 1. Drop sensitive credential keys wholesale.
      if (SENSITIVE_KEYS.has(normalized)) {
        out[key] = "[redacted]";
        continue;
      }

      // 2. Pseudonymize username fields.
      if (USERNAME_KEYS.has(normalized)) {
        out[key] =
          typeof entry === "string" && entry.trim()
            ? pseudonymize(entry)
            : "[pseudo:empty]";
        continue;
      }

      // 3. Pseudonymize address fields.
      if (ADDRESS_KEYS.has(normalized)) {
        out[key] =
          typeof entry === "string" && entry.trim()
            ? pseudonymize(entry)
            : "[pseudo:empty]";
        continue;
      }

      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }

  return "[redacted:unserializable]";
}

/**
 * Redact a context bag before it is attached to a Sentry event.
 *
 * Applies three passes in order:
 *  1. `scrubUserFields` — pseudonymize GitHub username fields.
 *  2. `scrubAddressFields` — pseudonymize Stellar address fields.
 *  3. `redactValue` — drop credential keys + scrub patterns in string values.
 *
 * Returns `undefined` for an absent context so callers can pass it straight
 * through to the SDK.
 */
export function redactContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  // All three passes are consolidated inside redactValue which now handles
  // username/address key detection alongside the SENSITIVE_KEYS check.
  return redactValue(context, 0) as Record<string, unknown>;
}

/**
 * Redact an exception before reporting.
 *
 * `Error` instances are cloned — same `name`, scrubbed `message` and `stack` —
 * rather than edited in place, because the caller usually goes on to log or
 * rethrow the original. Non-Error values are scrubbed as plain values.
 */
export function redactException(error: unknown): unknown {
  if (error instanceof Error) {
    const clone = new Error(redactString(error.message));
    clone.name = error.name;
    clone.stack = error.stack ? redactString(error.stack) : undefined;
    return clone;
  }
  return redactValue(error, 0);
}

// ---------------------------------------------------------------------------
// No-op stub (used when NEXT_PUBLIC_SENTRY_DSN is absent)
// ---------------------------------------------------------------------------

const noop = (): void => undefined;

const noopScope: SentryScope = {
  setTag: noop,
  setUser: noop,
  setExtra: noop,
  setLevel: noop,
};

const noopClient: SentryClient = {
  captureException: () => "",
  captureMessage: () => "",
  withScope: (cb) => cb(noopScope),
  setUser: noop,
  flush: async () => true,
};

// ---------------------------------------------------------------------------
// Client resolution
// ---------------------------------------------------------------------------

/**
 * Returns the resolved Sentry client.
 *
 * When `NEXT_PUBLIC_SENTRY_DSN` is set the real `@sentry/nextjs` package is
 * used; otherwise the no-op stub is returned so callers never need to null-
 * check the result.
 *
 * The dynamic `require()` is intentional: it allows the package to be an
 * optional peer dependency (not listed in `dependencies`) so that teams that
 * don't want Sentry can simply omit the DSN without an install step.
 */
function resolveClient(): SentryClient {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return noopClient;

  try {
    // Optional peer dependency: @sentry/nextjs is intentionally NOT installed.
    // Lazy require keeps plain deployments working without an install step.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/nextjs") as {
      captureException: (error: unknown, context?: Record<string, unknown>) => string;
      captureMessage: (message: string, level?: SentryLevel) => string;
      withScope: (callback: (scope: SentryScope) => void) => void;
      setUser: (user: { id?: string; username?: string } | null) => void;
      flush: (timeout?: number) => Promise<boolean>;
    };

    return {
      captureException: (error, context) =>
        Sentry.captureException(redactException(error), redactContext(context)),
      captureMessage: (message, level) => Sentry.captureMessage(redactString(message), level),
      withScope: (callback) => Sentry.withScope(callback),
      setUser: (user) => Sentry.setUser(user),
      flush: (timeout) => Sentry.flush(timeout),
    };
  } catch {
    // SDK not installed — fall back to the no-op stub rather than throwing
    // from an error-reporting path.
    return noopClient;
  }
}

let cachedClient: SentryClient | null = null;

/**
 * Test-only hook: drop the cached client so DSN/env changes take effect
 * between tests. Production code must never call this.
 */
export function _resetSentryClient(): void {
  cachedClient = null;
}

/**
 * The active Sentry client. Resolved lazily on first use so that importing
 * this module never has side effects and tests can stub the environment.
 */
export function getSentryClient(): SentryClient {
  if (!cachedClient) cachedClient = resolveClient();
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Report an exception to Sentry.
 *
 * The error and its context are redacted before they leave the process, so
 * callers can pass request-derived data (headers, bodies, params) without
 * worrying about leaking tokens or personal data. Never throws: a failure in
 * the reporter must not mask the original error.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): string {
  try {
    return getSentryClient().captureException(error, context);
  } catch {
    return "";
  }
}

/**
 * Report a message to Sentry at the given level (defaults to `error`).
 * Redacted and never throws, for the same reasons as {@link captureException}.
 */
export function captureMessage(
  message: string,
  level: SentryLevel = "error"
): string {
  try {
    return getSentryClient().captureMessage(message, level);
  } catch {
    return "";
  }
}

/**
 * Run `callback` with a configured Sentry scope. Never throws.
 */
export function withScope(callback: (scope: SentryScope) => void): void {
  try {
    getSentryClient().withScope(callback);
  } catch {
    // Swallow — scope configuration is best-effort.
  }
}

/**
 * Associate subsequent events with a user. Never throws.
 */
export function setUser(user: { id?: string; username?: string } | null): void {
  try {
    getSentryClient().setUser(user);
  } catch {
    // Swallow — user association is best-effort.
  }
}

/**
 * Flush buffered events. Useful in serverless handlers and tests. Never throws.
 */
export async function flush(timeout = 2000): Promise<boolean> {
  try {
    return await getSentryClient().flush(timeout);
  } catch {
    return false;
  }
}

/**
 * Whether Sentry reporting is active (a non-blank DSN is configured).
 * False in no-op mode — all helpers degrade silently.
 */
export function isSentryEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim());
}

/**
 * Flush buffered events. Alias kept for the pre-#418 helper name.
 * Useful in serverless handlers and tests. Never throws.
 */
export async function flushSentry(timeout = 2000): Promise<boolean> {
  return flush(timeout);
}

/**
 * Associate subsequent events with a user. Alias kept for the pre-#418
 * helper name. Never throws.
 */
export function setSentryUser(
  user: { id?: string; username?: string } | null
): void {
  setUser(user);
}

/**
 * Report an exception with user + scope context attached.
 * Never throws: returns "" when reporting is unavailable.
 */
export function captureExceptionWithScope(
  error: unknown,
  user?: { id?: string; username?: string } | null,
  context?: Record<string, unknown>,
  level: SentryLevel = "error"
): string {
  try {
    withScope((scope) => {
      if (user) scope.setUser(user);
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          scope.setExtra(key, value);
        }
      }
      scope.setLevel(level);
    });
    return captureException(error, context);
  } catch {
    return "";
  }
}


export interface SentryScope {
  setTag(key: string, value: string): void;
  setUser(user: { id?: string; username?: string } | null): void;
  setExtra(key: string, value: unknown): void;
  setLevel(level: SentryLevel): void;
}

export type SentryLevel = "debug" | "info" | "warning" | "error" | "fatal";

export interface SentryClient {
  captureException(error: unknown, context?: Record<string, unknown>): string;
  captureMessage(message: string, level?: SentryLevel): string;
  withScope(callback: (scope: SentryScope) => void): void;
  setUser(user: { id?: string; username?: string } | null): void;
  flush(timeout?: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns scrubbed from every string that reaches Sentry.
 *
 * Ordering matters: the more specific GitHub token patterns run before the
 * generic long-hex rule so a `ghp_…` token is labelled as a token rather than
 * as an anonymous secret.
 *
 * These are deliberately conservative. Over-redacting a stack frame costs a
 * little debuggability; under-redacting ships a contributor's wallet address
 * or a maintainer's GitHub token to a third-party service, which is the thing
 * this project cannot take back.
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // GitHub fine-grained PATs: github_pat_<22>_<59>
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted:github-token]" },
  // Classic/OAuth/app tokens: ghp_, gho_, ghu_, ghs_, ghr_
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[redacted:github-token]" },
  // Stellar public keys (G…) and secret seeds (S…). Both are 56-char base32.
  // Secrets must never appear anywhere; public G-addresses are personal data
  // that ties a GitHub identity to an on-chain balance, so they go too.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: "[redacted:stellar-secret]" },
  { pattern: /\bG[A-Z2-7]{55}\b/g, replacement: "[redacted:stellar-address]" },
  // Postgres/other connection strings carrying inline credentials.
  { pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@]+@/gi, replacement: "$1://[redacted:credentials]@" },
  // Authorization header values.
  { pattern: /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "$1 [redacted:token]" },
  // Email addresses.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[redacted:email]" },
];

/** Context keys whose value is dropped wholesale, whatever it looks like. */
const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "sessiontoken",
  "session_token",
  "tokenencryptionkey",
  "token_encryption_key",
]);

/** Depth cap, so a cyclic or pathological object can't hang the reporter. */
const MAX_REDACT_DEPTH = 6;

/**
 * Scrub secrets and personal data out of a single string.
 *
 * Exported for tests and for callers that build their own message strings.
 */
export function redactString(input: string): string {
  let output = input;
  for (const { pattern, replacement } of REDACTION_RULES) {
    // Rules are module-level and therefore stateful with the /g flag; reset
    // lastIndex so a previous call can't cause a missed match.
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Recursively redact an arbitrary value: strings are scrubbed, objects are
 * walked, and any key in {@link SENSITIVE_KEYS} is dropped entirely.
 *
 * Errors are converted to a plain object rather than mutated, so the caller's
 * own error instance is never modified by the act of reporting it.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[redacted:max-depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }

  return "[redacted:unserializable]";
}

/**
 * Redact a context bag before it is attached to a Sentry event.
 * Returns `undefined` for an absent context so callers can pass it straight
 * through to the SDK.
 */
export function redactContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return redactValue(context, 0) as Record<string, unknown>;
}

/**
 * Redact an exception before reporting.
 *
 * `Error` instances are cloned — same `name`, scrubbed `message` and `stack` —
 * rather than edited in place, because the caller usually goes on to log or
 * rethrow the original. Non-Error values are scrubbed as plain values.
 */
export function redactException(error: unknown): unknown {
  if (error instanceof Error) {
    const clone = new Error(redactString(error.message));
    clone.name = error.name;
    clone.stack = error.stack ? redactString(error.stack) : undefined;
    return clone;
  }
  return redactValue(error, 0);
}

// ---------------------------------------------------------------------------
// No-op stub (used when NEXT_PUBLIC_SENTRY_DSN is absent)
// ---------------------------------------------------------------------------

const noop = (): void => undefined;

const noopScope: SentryScope = {
  setTag: noop,
  setUser: noop,
  setExtra: noop,
  setLevel: noop,
};

const noopClient: SentryClient = {
  captureException: () => "",
  captureMessage: () => "",
  withScope: (cb) => cb(noopScope),
  setUser: noop,
  flush: async () => true,
};

// ---------------------------------------------------------------------------
// Client resolution
// ---------------------------------------------------------------------------

/**
 * Returns the resolved Sentry client.
 *
 * When `NEXT_PUBLIC_SENTRY_DSN` is set the real `@sentry/nextjs` package is
 * used; otherwise the no-op stub is returned so callers never need to null-
 * check the result.
 *
 * The dynamic `require()` is intentional: it allows the package to be an
 * optional peer dependency (not listed in `dependencies`) so that teams that
 * don't want Sentry can simply omit the DSN without an install step.
 */
function resolveClient(): SentryClient {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return noopClient;

  try {
    // Optional peer dependency: @sentry/nextjs is intentionally NOT installed.
    // Lazy require keeps plain deployments working without an install step.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/nextjs") as {
      captureException: (error: unknown, context?: Record<string, unknown>) => string;
      captureMessage: (message: string, level?: SentryLevel) => string;
      withScope: (callback: (scope: SentryScope) => void) => void;
      setUser: (user: { id?: string; username?: string } | null) => void;
      flush: (timeout?: number) => Promise<boolean>;
    };

    return {
      captureException: (error, context) =>
        Sentry.captureException(redactException(error), redactContext(context)),
      captureMessage: (message, level) => Sentry.captureMessage(redactString(message), level),
      withScope: (callback) => Sentry.withScope(callback),
      setUser: (user) => Sentry.setUser(user),
      flush: (timeout) => Sentry.flush(timeout),
    };
  } catch {
    // SDK not installed — fall back to the no-op stub rather than throwing
    // from an error-reporting path.
    return noopClient;
  }
}

let cachedClient: SentryClient | null = null;

/**
 * Test-only hook: drop the cached client so DSN/env changes take effect
 * between tests. Production code must never call this.
 */
export function _resetSentryClient(): void {
  cachedClient = null;
}

/**
 * The active Sentry client. Resolved lazily on first use so that importing
 * this module never has side effects and tests can stub the environment.
 */
export function getSentryClient(): SentryClient {
  if (!cachedClient) cachedClient = resolveClient();
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Report an exception to Sentry.
 *
 * The error and its context are redacted before they leave the process, so
 * callers can pass request-derived data (headers, bodies, params) without
 * worrying about leaking tokens or personal data. Never throws: a failure in
 * the reporter must not mask the original error.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): string {
  try {
    return getSentryClient().captureException(error, context);
  } catch {
    return "";
  }
}

/**
 * Report a message to Sentry at the given level (defaults to `error`).
 * Redacted and never throws, for the same reasons as {@link captureException}.
 */
export function captureMessage(
  message: string,
  level: SentryLevel = "error"
): string {
  try {
    return getSentryClient().captureMessage(message, level);
  } catch {
    return "";
  }
}

/**
 * Run `callback` with a configured Sentry scope. Never throws.
 */
export function withScope(callback: (scope: SentryScope) => void): void {
  try {
    getSentryClient().withScope(callback);
  } catch {
    // Swallow — scope configuration is best-effort.
  }
}

/**
 * Associate subsequent events with a user. Never throws.
 */
export function setUser(user: { id?: string; username?: string } | null): void {
  try {
    getSentryClient().setUser(user);
  } catch {
    // Swallow — user association is best-effort.
  }
}

/**
 * Flush buffered events. Useful in serverless handlers and tests. Never throws.
 */
export async function flush(timeout = 2000): Promise<boolean> {
  try {
    return await getSentryClient().flush(timeout);
  } catch {
    return false;
  }
}

/**
 * Whether Sentry reporting is active (a non-blank DSN is configured).
 * False in no-op mode — all helpers degrade silently.
 */
export function isSentryEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim());
}

/**
 * Flush buffered events. Alias kept for the pre-#418 helper name.
 * Useful in serverless handlers and tests. Never throws.
 */
export async function flushSentry(timeout = 2000): Promise<boolean> {
  return flush(timeout);
}

/**
 * Associate subsequent events with a user. Alias kept for the pre-#418
 * helper name. Never throws.
 */
export function setSentryUser(
  user: { id?: string; username?: string } | null
): void {
  setUser(user);
}

/**
 * Report an exception with user + scope context attached.
 * Never throws: returns "" when reporting is unavailable.
 */
export function captureExceptionWithScope(
  error: unknown,
  user?: { id?: string; username?: string } | null,
  context?: Record<string, unknown>,
  level: SentryLevel = "error"
): string {
  try {
    withScope((scope) => {
      if (user) scope.setUser(user);
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          scope.setExtra(key, value);
        }
      }
      scope.setLevel(level);
    });
    return captureException(error, context);
  } catch {
    return "";
  }
}
