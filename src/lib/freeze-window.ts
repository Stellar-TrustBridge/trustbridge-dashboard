import { NextRequest, NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { isFeatureEnabled } from "@/lib/feature-flags";

export interface FreezeWindowStatus {
  active: boolean;
  reason?: string;
  start?: Date;
  end?: Date;
}

/**
 * A single freeze window interval. `start`/`end` are UTC instants; the window
 * is inclusive of both endpoints.
 */
export interface FreezeWindowInterval {
  start: Date;
  end: Date;
}

/**
 * Stable reason codes emitted by the freeze-window overlap policy. Documented
 * in `docs/ENVIRONMENT.md`; keep in sync with tests.
 *
 * - FREEZE_WINDOW_INVALID: a window is missing, unparseable, or inverted.
 * - FREEZE_WINDOW_OVERSIZED: more windows than the supported maximum.
 * - FREEZE_WINDOW_OVERLAP_REJECTED: overlapping windows were supplied while
 *   the policy is set to reject (FREEZE_WINDOW_OVERLAP_POLICY=reject).
 */
export type FreezeWindowReasonCode =
  | "FREEZE_WINDOW_INVALID"
  | "FREEZE_WINDOW_OVERSIZED"
  | "FREEZE_WINDOW_OVERLAP_REJECTED";

/** Maximum number of windows accepted before failing closed. */
export const MAX_FREEZE_WINDOWS = 32;

/**
 * Overlap policy for multiple freeze windows. Defaults to "merge":
 * overlapping and adjacent windows are unioned into a canonical, sorted set of
 * non-overlapping intervals. "reject" fails closed when any overlap is found.
 * Configured via FREEZE_WINDOW_OVERLAP_POLICY (see docs/ENVIRONMENT.md).
 */
export type FreezeWindowOverlapPolicy = "merge" | "reject";

export function getFreezeWindowOverlapPolicy(): FreezeWindowOverlapPolicy {
  const raw = process.env.FREEZE_WINDOW_OVERLAP_POLICY?.trim().toLowerCase();
  return raw === "reject" ? "reject" : "merge";
}

/**
 * Parses a raw window list and applies the overlap policy. Returns the
 * canonical (sorted, merged) intervals on success, or a stable reason code on
 * failure. Empty input yields an empty interval list (no freeze).
 */
export function resolveFreezeWindows(
  windows: Array<{ start: string | Date; end: string | Date }>,
  policy: FreezeWindowOverlapPolicy = getFreezeWindowOverlapPolicy()
):
  | { ok: true; windows: FreezeWindowInterval[] }
  | { ok: false; code: FreezeWindowReasonCode } {
  if (windows.length > MAX_FREEZE_WINDOWS) {
    return { ok: false, code: "FREEZE_WINDOW_OVERSIZED" };
  }

  const parsed: FreezeWindowInterval[] = [];
  for (const w of windows) {
    const start = w.start instanceof Date ? w.start : new Date(w.start);
    const end = w.end instanceof Date ? w.end : new Date(w.end);
    if (
      isNaN(start.getTime()) ||
      isNaN(end.getTime()) ||
      start.getTime() > end.getTime()
    ) {
      return { ok: false, code: "FREEZE_WINDOW_INVALID" };
    }
    parsed.push({ start, end });
  }

  parsed.sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: FreezeWindowInterval[] = [];
  for (const current of parsed) {
    const last = merged[merged.length - 1];
    // Overlap or adjacency (touching endpoints) collapses into one window.
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (policy === "reject") {
        return { ok: false, code: "FREEZE_WINDOW_OVERLAP_REJECTED" };
      }
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return { ok: true, windows: merged };
}

/**
 * Environment variables consumed by the freeze-window guard. Documented in
 * `docs/ENVIRONMENT.md` and referenced from `docs/FEATURE_FLAGS.md`.
 *
 * - FREEZE_WINDOW_ENABLED: "true" | "false" (case-insensitive, trimmed).
 *   "false" explicitly disables the window regardless of start/end.
 * - FREEZE_WINDOW_START: ISO-8601 timestamp (e.g. 2025-01-01T00:00:00Z).
 * - FREEZE_WINDOW_END: ISO-8601 timestamp (e.g. 2025-01-08T00:00:00Z).
 * - FREEZE_WINDOW_TIMEZONE: IANA timezone used for display only (e.g.
 *   "America/New_York"). Defaults to "UTC". Storage and comparisons always
 *   use UTC instants; this only affects human-facing rendering.
 * - FREEZE_WINDOW_OVERLAP_POLICY: "merge" (default) | "reject". Controls how
 *   overlapping/adjacent windows are handled by `resolveFreezeWindows`.
 *
 * The window is active when now is within [start, end] inclusive. Missing,
 * unparseable, or inverted (start > end) values fail closed to inactive.
 * The `freeze_window` feature flag must also be enabled for the guard to
 * block requests (see `enforceFreezeWindowGuard`).
 */
export function isFreezeWindowActive(now = new Date()): FreezeWindowStatus {
  const enabledStr = process.env.FREEZE_WINDOW_ENABLED?.trim().toLowerCase();
  const startStr = process.env.FREEZE_WINDOW_START?.trim();
  const endStr = process.env.FREEZE_WINDOW_END?.trim();

  // Explicitly disabled
  if (enabledStr === "false") {
    return { active: false };
  }

  if (!startStr || !endStr) {
    return { active: false };
  }

  const resolved = resolveFreezeWindows([{ start: startStr, end: endStr }]);
  if (!resolved.ok || resolved.windows.length === 0) {
    return { active: false };
  }

  const { start, end } = resolved.windows[0];

  const nowTime = now.getTime();
  const active = nowTime >= start.getTime() && nowTime <= end.getTime();
  if (active) {
    return {
      active: true,
      reason: "Wave roster payout freeze window in effect",
      start,
      end,
    };
  }

  return { active: false, start, end };
}

/**
 * Resolves the org-configured display timezone. Falls back to "UTC" when the
 * env var is missing or not a valid IANA zone so display never throws.
 */
export function getFreezeWindowTimezone(): string {
  const tz = process.env.FREEZE_WINDOW_TIMEZONE?.trim();
  if (!tz) {
    return "UTC";
  }
  try {
    // Throws RangeError for invalid IANA zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * Formats a UTC instant for display in the org timezone. Returns null for
 * missing/invalid dates so callers can omit the field. DST boundaries are
 * handled by Intl, which resolves the correct offset for the given instant.
 */
export function formatFreezeInstant(
  date: Date | undefined,
  timeZone = getFreezeWindowTimezone()
): string | null {
  if (!date || isNaN(date.getTime())) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "long",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "long",
    }).format(date);
  }
}

/**
 * Builds the timezone-aware freeze window payload shared by the API route and
 * the cron digest. UTC instants are always included; display strings are
 * rendered in the org timezone.
 */
export function buildFreezeWindowPayload(status: FreezeWindowStatus): {
  active: boolean;
  reason?: string;
  start: string | null;
  end: string | null;
  timezone: string;
  startDisplay: string | null;
  endDisplay: string | null;
} {
  const timezone = getFreezeWindowTimezone();
  return {
    active: status.active,
    reason: status.reason,
    start: status.start?.toISOString() ?? null,
    end: status.end?.toISOString() ?? null,
    timezone,
    startDisplay: formatFreezeInstant(status.start, timezone),
    endDisplay: formatFreezeInstant(status.end, timezone),
  };
}

/**
 * Evaluates whether a request should be blocked by an active freeze window.
 * Maintainers can supply header `x-freeze-override: true` or query param `overrideFreeze=true`
 * to bypass the freeze window, which gets audited.
 */
export async function enforceFreezeWindowGuard({
  request,
  isMaintainer = false,
  userId = null,
  userLogin = null,
  actionLabel = "recheck",
}: {
  request: NextRequest;
  isMaintainer?: boolean;
  userId?: string | null;
  userLogin?: string | null;
  actionLabel?: string;
}): Promise<{ blocked: boolean; response?: NextResponse; isOverride: boolean }> {
  const flagEnabled = await isFeatureEnabled("freeze_window");
  if (!flagEnabled) {
    return { blocked: false, isOverride: false };
  }

  const status = isFreezeWindowActive();
  if (!status.active) {
    return { blocked: false, isOverride: false };
  }

  const headerOverride = request.headers.get("x-freeze-override")?.toLowerCase() === "true";
  const url = new URL(request.url);
  const queryOverride = url.searchParams.get("overrideFreeze")?.toLowerCase() === "true";
  const hasOverrideRequested = headerOverride || queryOverride;

  if (hasOverrideRequested && isMaintainer) {
    // Record maintainer override audit event
    await recordAuditLog({
      action: `${actionLabel}.freeze_override`,
      actorId: userId ?? "system",
      actorLogin: userLogin ?? null,
      metadata: {
        reason: "Maintainer override during active wave freeze window",
        freezeStart: status.start?.toISOString(),
        freezeEnd: status.end?.toISOString(),
      },
    });
    return { blocked: false, isOverride: true };
  }

  // Audit blocked attempt
  await recordAuditLog({
    action: `${actionLabel}.freeze_blocked`,
    actorId: userId ?? "anonymous",
    actorLogin: userLogin ?? null,
    metadata: {
      reason: status.reason,
      freezeStart: status.start?.toISOString(),
      freezeEnd: status.end?.toISOString(),
      overrideAttempted: hasOverrideRequested,
    },
  });

  const freezeWindow = buildFreezeWindowPayload(status);

  return {
    blocked: true,
    isOverride: false,
    response: NextResponse.json(
      {
        error:
          "Roster is currently frozen for wave payout. Address changes and rechecks are temporarily disabled.",
        code: "WAVE_FREEZE_ACTIVE",
        freezeWindow,
      },
      { status: 423 }
    ),
  };
}
