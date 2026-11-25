/**
 * Wave status public banner module.
 *
 * Merges two independent operational signals into a single typed payload that
 * contributors, maintainers, and monitoring tools can consume via
 * `GET /api/wave-status`:
 *
 * 1. **Freeze window** (`src/lib/freeze-window.ts`) — whether the roster is
 *    frozen for Wave payout. Prevents rechecks and address changes.
 * 2. **Contract-sync queue lag** (`src/lib/contract-sync.ts`) — whether the
 *    Soroban contract→Postgres sync is lagging or stalled. A lagging sync
 *    means the dashboard may show stale on-chain data.
 *
 * The combined `WavePublicStatus.overallStatus` is the single signal the
 * banner UI renders:
 *
 * | overallStatus | Meaning |
 * |---|---|
 * | `ok` | No active issues. |
 * | `frozen` | Roster is frozen for Wave payout. |
 * | `degraded` | Contract sync is lagging or stalled. |
 * | `frozen_and_degraded` | Both signals are active simultaneously. |
 *
 * The module is **pure server-side** (imports `server-only` in its callers)
 * but `wave-status.ts` itself is kept import-free from `server-only` so that
 * the type definitions and pure helpers remain usable in tests and UI code
 * that imports the types only.
 */

// ---------------------------------------------------------------------------
// Badge variant types (preserved from the original module)
// ---------------------------------------------------------------------------

export type WaveStatus = "pass" | "fail" | "skipped" | "frozen";

export type WaveStatusBadgeVariant = "ready" | "danger" | "warning";

export const WAVE_STATUS_BADGE_VARIANT: Record<
  WaveStatus,
  WaveStatusBadgeVariant
> = {
  pass: "ready",
  fail: "danger",
  skipped: "warning",
  frozen: "warning",
};

export const WAVE_STATUS_BADGE_CLASSES: Record<WaveStatus, string> = {
  pass: "border-transparent bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  fail: "border-transparent bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  skipped:
    "border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  frozen:
    "border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};

// ---------------------------------------------------------------------------
// Public banner types
// ---------------------------------------------------------------------------

/** Overall operational status surfaced on `GET /api/wave-status`. */
export type WavePublicOverallStatus =
  | "ok"
  | "frozen"
  | "degraded"
  | "frozen_and_degraded";

/** Freeze-window section of the public banner payload. */
export interface WavePublicFreezeSignal {
  active: boolean;
  reason: string | null;
  /** UTC ISO-8601 start of the active freeze window, or null. */
  start: string | null;
  /** UTC ISO-8601 end of the active freeze window, or null. */
  end: string | null;
}

/** Contract-sync lag section of the public banner payload. */
export interface WavePublicLagSignal {
  /** `ok` | `lagging` | `stalled` */
  status: string;
  /** Stable reason code (see ARCHITECTURE.md for the full table). */
  reason: string;
  /** Milliseconds since the last successful sync, or null when never synced. */
  sinceLastSuccessMs: number | null;
  /** Configured lag threshold in ms. */
  thresholdMs: number;
}

/**
 * Typed payload returned by `GET /api/wave-status` and by `getWavePublicStatus()`.
 *
 * Shape is intentionally narrow — no internal fields, no PII, no Prisma types.
 * Downstream consumers (UI banner, monitoring scripts, the action workflow)
 * can safely deserialize this without knowing dashboard internals.
 */
export interface WavePublicStatus {
  overallStatus: WavePublicOverallStatus;
  freeze: WavePublicFreezeSignal;
  queueLag: WavePublicLagSignal;
  /**
   * Human-readable banner message. At most one sentence; safe to render
   * verbatim in a UI without further transformation.
   */
  message: string;
  /** UTC ISO-8601 timestamp of when this status was computed. */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the `overallStatus` from the two independent signals. Pure so it is
 * testable without I/O.
 */
export function deriveOverallStatus(
  freezeActive: boolean,
  lagStatus: string
): WavePublicOverallStatus {
  const lagDegraded = lagStatus === "lagging" || lagStatus === "stalled";
  if (freezeActive && lagDegraded) return "frozen_and_degraded";
  if (freezeActive) return "frozen";
  if (lagDegraded) return "degraded";
  return "ok";
}

/**
 * Compose a human-readable banner message from the overall status.
 * Written for contributors who have no context about the internals.
 */
export function composeBannerMessage(
  overallStatus: WavePublicOverallStatus,
  freezeReason: string | null,
  lagReason: string
): string {
  switch (overallStatus) {
    case "ok":
      return "Wave systems are operating normally.";
    case "frozen":
      return (
        freezeReason ??
        "The Wave roster is currently frozen. Rechecks and address changes are temporarily disabled."
      );
    case "degraded":
      if (lagReason === "cursor_stalled") {
        return "Contract sync is running but the on-chain cursor has not advanced. Dashboard data may be stale.";
      }
      if (lagReason === "sync_stalled") {
        return "Contract sync has stalled. Dashboard data may not reflect recent on-chain activity.";
      }
      if (lagReason === "sync_delayed") {
        return "Contract sync is delayed. Dashboard data may be slightly stale.";
      }
      if (lagReason === "never_succeeded") {
        return "Contract sync has not completed successfully since startup. Dashboard data may be incomplete.";
      }
      return "Wave contract sync is degraded. Dashboard data may be stale.";
    case "frozen_and_degraded":
      return "Wave roster is frozen and contract sync is degraded. Address changes are disabled and dashboard data may be stale.";
  }
}

// ---------------------------------------------------------------------------
// Server-side factory (imports server-only dependencies at call time)
// ---------------------------------------------------------------------------

/**
 * Options for `getWavePublicStatus`. Primarily used in tests to inject
 * frozen clocks and pre-computed freeze / lag state rather than reading
 * live environment.
 */
export interface WavePublicStatusOptions {
  /** Injected freeze state (skips `isFreezeWindowActive()` call). */
  freezeState?: { active: boolean; reason?: string; start?: Date; end?: Date };
  /** Injected lag state (skips `getContractSyncLagState()` call). */
  lagState?: {
    status: string;
    reason: string;
    sinceLastSuccessMs: number | null;
    thresholdMs: number;
  };
  /** Override the computed timestamp (for deterministic test snapshots). */
  now?: Date;
}

/**
 * Compute the full Wave public status banner payload.
 *
 * In production (`options` omitted), reads live process state from
 * `isFreezeWindowActive()` and `getContractSyncLagState()`. In tests, inject
 * `options.freezeState` / `options.lagState` to drive every code path without
 * side effects.
 *
 * **Never throws** — if either subsystem fails to read its state, the
 * corresponding signal defaults to the safest non-alarming value so the
 * banner degrades gracefully instead of crashing the route.
 */
export async function getWavePublicStatus(
  options: WavePublicStatusOptions = {}
): Promise<WavePublicStatus> {
  const computedAt = (options.now ?? new Date()).toISOString();

  // ── Freeze signal ─────────────────────────────────────────────────────────
  let freeze: WavePublicFreezeSignal;
  if (options.freezeState !== undefined) {
    freeze = {
      active: options.freezeState.active,
      reason: options.freezeState.reason ?? null,
      start: options.freezeState.start?.toISOString() ?? null,
      end: options.freezeState.end?.toISOString() ?? null,
    };
  } else {
    try {
      // Dynamic import keeps server-only deps out of the pure module graph.
      const { isFreezeWindowActive } = await import("@/lib/freeze-window");
      const status = isFreezeWindowActive();
      freeze = {
        active: status.active,
        reason: status.reason ?? null,
        start: status.start?.toISOString() ?? null,
        end: status.end?.toISOString() ?? null,
      };
    } catch {
      freeze = { active: false, reason: null, start: null, end: null };
    }
  }

  // ── Queue lag signal ───────────────────────────────────────────────────────
  let queueLag: WavePublicLagSignal;
  if (options.lagState !== undefined) {
    queueLag = {
      status: options.lagState.status,
      reason: options.lagState.reason,
      sinceLastSuccessMs: options.lagState.sinceLastSuccessMs,
      thresholdMs: options.lagState.thresholdMs,
    };
  } else {
    try {
      const { getContractSyncLagState } = await import("@/lib/contract-sync");
      const lag = getContractSyncLagState();
      queueLag = {
        status: lag.status,
        reason: lag.reason,
        sinceLastSuccessMs: lag.sinceLastSuccessMs,
        thresholdMs: lag.thresholdMs,
      };
    } catch {
      queueLag = {
        status: "ok",
        reason: "no_data",
        sinceLastSuccessMs: null,
        thresholdMs: 0,
      };
    }
  }

  const overallStatus = deriveOverallStatus(freeze.active, queueLag.status);
  const message = composeBannerMessage(overallStatus, freeze.reason, queueLag.reason);

  return { overallStatus, freeze, queueLag, message, computedAt };
}
