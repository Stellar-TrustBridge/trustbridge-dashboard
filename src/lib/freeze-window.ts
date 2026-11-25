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
 * Stable reason code returned when FREEZE_WINDOW_START/END are inverted
 * (end <= start). Surfaced by the freeze-status API as HTTP 422.
 */
export const FREEZE_WINDOW_INVERTED_RANGE = "FREEZE_WINDOW_INVERTED_RANGE";

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
 *
 * The window is active when now is within [start, end] inclusive. Missing,
 * unparseable, or inverted (start >= end) values fail closed to inactive.
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

  const start = new Date(startStr);
  const end = new Date(endStr);

  if (
    isNaN(start.getTime()) ||
    isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    return { active: false };
  }

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
 * Validates the configured freeze window range. Returns a stable error object
 * when the range is inverted (end <= start) so the API can respond with a
 * clear 422 instead of silently treating the window as inactive.
 *
 * Returns null when the range is valid, disabled, or unconfigured.
 */
export function validateFreezeWindowRange(): {
  code: string;
  message: string;
  start: string;
  end: string;
} | null {
  const enabledStr = process.env.FREEZE_WINDOW_ENABLED?.trim().toLowerCase();
  if (enabledStr === "false") {
    return null;
  }

  const startStr = process.env.FREEZE_WINDOW_START?.trim();
  const endStr = process.env.FREEZE_WINDOW_END?.trim();
  if (!startStr || !endStr) {
    return null;
  }

  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return null;
  }

  if (end.getTime() <= start.getTime()) {
    return {
      code: FREEZE_WINDOW_INVERTED_RANGE,
      message:
        "FREEZE_WINDOW_END must be strictly after FREEZE_WINDOW_START; the configured freeze window range is inverted.",
      start: start.toISOString(),
      end: end.toISOString(),
    };
  }

  return null;
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
