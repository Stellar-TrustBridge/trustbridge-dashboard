import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Feature flags for the TrustBridge Dashboard (issue #201).
 *
 * Resolution order for every flag:
 *   1. Environment override  — `FEATURE_FLAG_<KEY>` (e.g. FEATURE_FLAG_BATCH_RECHECK)
 *   2. Database row          — only when `FEATURE_FLAGS_DB_ENABLED` is truthy
 *   3. Built-in default      — the `default` field below
 *
 * "Fail closed" for risky writes: when the DB source is enabled but unreadable
 * (connection error, migration not applied, …) a `risky` flag resolves to
 * `false` regardless of its default, so a database outage can never silently
 * open a dangerous code path.
 *
 * DB reads are cached in-process for `FEATURE_FLAGS_CACHE_TTL_MS` (default 30s).
 * Call {@link clearFeatureFlagCache} after writing a flag so the change is
 * visible immediately in the current process.
 *
 * Freeze interactions (issue #588): when `freeze_window` is enabled and a
 * freeze window is active, registration and exports are blocked. Use
 * {@link getFreezeInteraction} to obtain user-facing copy for the registration
 * and settings UIs instead of leaving contributors at a dead end.
 *
 * Kill switch (issue #771): the readiness / wave-status UI is gated by the
 * `readiness_ui` flag. Operators disable it during incidents with
 * `FEATURE_FLAG_READINESS_UI=0` (env override wins over DB and default). See
 * `docs/FEATURE_FLAGS.md` for the full runbook and audit expectations.
 */

export type FeatureFlagKey =
  | "batch_recheck"
  | "invite_generation"
  | "dlq_retry"
  | "maintenance_mode"
  | "otel_traces"
  | "freeze_window"
  | "readiness_ui";

interface FlagDefinition {
  description: string;
  /** Value used when there is no env override and no usable DB row. */
  default: boolean;
  /**
   * Risky flags gate mutating / destructive behaviour. They fail closed: if
   * the DB source is enabled but unreadable, the flag resolves to `false`.
   */
  risky: boolean;
}

export const FEATURE_FLAGS: Record<FeatureFlagKey, FlagDefinition> = {
  batch_recheck: {
    description:
      "Allow maintainers to enqueue a full batch recheck of every contributor.",
    default: true,
    risky: true,
  },
  invite_generation: {
    description: "Allow maintainers to generate invite codes.",
    default: true,
    risky: true,
  },
  dlq_retry: {
    description:
      "Allow maintainers to retry failed jobs and Soroban outbox items from their dead-letter queues.",
    default: true,
    risky: true,
  },
  maintenance_mode: {
    description:
      "Serve the maintenance banner and 503 mutating APIs. The MAINTENANCE=1 env var does the same and is the recommended kill switch.",
    default: false,
    risky: true,
  },
  otel_traces: {
    description:
      "Emit OpenTelemetry-style spans for API routes, Prisma and Horizon calls. Also toggled by OTEL_TRACES_ENABLED.",
    default: false,
    risky: false,
  },
  freeze_window: {
    description:
      "Enforce wave freeze-window blocking on mutating APIs. When OFF, freeze-window helpers never block requests regardless of FREEZE_WINDOW_* env vars.",
    default: true,
    risky: true,
  },
  readiness_ui: {
    description:
      "Render the readiness / wave-status UI and its read APIs. Kill switch: set FEATURE_FLAG_READINESS_UI=0 to hide the UI and return 503 from readiness read APIs during incidents. See docs/FEATURE_FLAGS.md.",
    default: true,
    risky: false,
  },
};

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

function envOverride(key: FeatureFlagKey): boolean | undefined {
  return parseBoolEnv(process.env[`FEATURE_FLAG_${key.toUpperCase()}`]);
}

function dbSourceEnabled(): boolean {
  return parseBoolEnv(process.env.FEATURE_FLAGS_DB_ENABLED) === true;
}

function cacheTtlMs(): number {
  const n = Number.parseInt(process.env.FEATURE_FLAGS_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

interface DbCacheEntry {
  /** null value => DB source enabled but the read failed (fail-closed path). */
  flags: Map<string, boolean> | null;
  expiresAt: number;
}

let dbCache: DbCacheEntry | null = null;

/** Drop the cached DB snapshot so the next read hits the database again. */
export function clearFeatureFlagCache(): void {
  dbCache = null;
}

async function readDbFlags(): Promise<Map<string, boolean> | null> {
  const now = Date.now();
  if (dbCache && dbCache.expiresAt > now) return dbCache.flags;

  try {
    const rows = await prisma.featureFlag.findMany({
      select: { key: true, enabled: true },
    });
    const map = new Map<string, boolean>();
    for (const row of rows) map.set(row.key, row.enabled);
    dbCache = { flags: map, expiresAt: now + cacheTtlMs() };
    return map;
  } catch (error) {
    console.error("[feature-flags] database read failed; failing closed", error);
    // Cache the failure briefly so a hard DB outage doesn't hammer the pool.
    dbCache = { flags: null, expiresAt: now + Math.min(cacheTtlMs(), 5_000) };
    return null;
  }
}

export type FlagSource = "env" | "db" | "default" | "fail-closed";

/**
 * Percentage rollout with sticky bucketing (issue #661).
 *
 * Algorithm (documented for operators — do not invent a parallel scheme):
 * 1. Subject key = `${flagKey}:${scope}:${subjectId}` where scope is `user`
 *    or `org` and subjectId is the stable GitHub/org id (never a display name).
 * 2. FNV-1a 32-bit hash of the UTF-8 subject key → unsigned 32-bit int.
 * 3. Bucket = hash % 100 (range 0..99).
 * 4. Enabled for this subject iff `bucket < rolloutPercent`.
 *
 * Boundaries: percent <= 0 → always off; percent >= 100 → always on.
 * The same (flag, scope, subjectId) always lands in the same bucket, so the
 * UI does not flicker between evaluations (sticky per user/org).
 */
export function rolloutBucket(
  flagKey: string,
  scope: "user" | "org",
  subjectId: string
): number {
  const input = `${flagKey}:${scope}:${subjectId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

/** True when `subjectId` falls inside the percentage rollout for `flagKey`. */
export function isInRollout(
  flagKey: string,
  scope: "user" | "org",
  subjectId: string,
  rolloutPercent: number
): boolean {
  if (!Number.isFinite(rolloutPercent) || rolloutPercent <= 0) return false;
  if (rolloutPercent >= 100) return true;
  return rolloutBucket(flagKey, scope, subjectId) < rolloutPercent;
}

/**
 * Read an optional percentage rollout for a flag from
 * `FEATURE_FLAG_<KEY>_ROLLOUT_PERCENT` (0–100). Unset / invalid → undefined
 * (flag behaves as a full on/off switch, matching pre-#661 behavior).
 */
export function getRolloutPercent(key: FeatureFlagKey): number | undefined {
  const raw = process.env[`FEATURE_FLAG_${key.toUpperCase()}_ROLLOUT_PERCENT`];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n;
}

/**
 * Human-readable label for a flag source, for the admin read-only panel.
 */
export function flagSourceLabel(source: FlagSource): string {
  switch (source) {
    case "env":
      return "Environment override";
    case "db":
      return "Database";
    case "default":
      return "Built-in default";
    case "fail-closed":
      return "Fail-closed (DB unreadable)";
  }
}

export interface ResolvedFlag {
  key: FeatureFlagKey;
  description: string;
  enabled: boolean;
  source: FlagSource;
  risky: boolean;
}

function resolve(
  key: FeatureFlagKey,
  dbFlags: Map<string, boolean> | null,
): ResolvedFlag {
  const def = FEATURE_FLAGS[key];
  const base = { key, description: def.description, risky: def.risky };

  const override = envOverride(key);
  if (override !== undefined) {
    return { ...base, enabled: override, source: "env" };
  }

  if (dbSourceEnabled()) {
    if (dbFlags === null) {
      // Unreadable DB source: risky flags fail closed, others fall back to default.
      return {
        ...base,
        enabled: def.risky ? false : def.default,
        source: "fail-closed",
      };
    }
    const dbValue = dbFlags.get(key);
    if (dbValue !== undefined) {
      return { ...base, enabled: dbValue, source: "db" };
    }
  }

  return { ...base, enabled: def.default, source: "default" };
}

/** Resolve a single flag using the documented precedence order. */
export async function getFeatureFlag(key: FeatureFlagKey): Promise<ResolvedFlag> {
  const dbFlags = dbSourceEnabled() ? await readDbFlags() : null;
  return resolve(key, dbFlags);
}

/** Convenience boolean check for a single flag. */
export async function isFeatureEnabled(key: FeatureFlagKey): Promise<boolean> {
  return (await getFeatureFlag(key)).enabled;
}

/** Resolve every known flag (used by the admin read-only panel). */
export async function getAllFeatureFlags(): Promise<ResolvedFlag[]> {
  const dbFlags = dbSourceEnabled() ? await readDbFlags() : null;
  return FEATURE_FLAG_KEYS.map((key) => resolve(key, dbFlags));
}
