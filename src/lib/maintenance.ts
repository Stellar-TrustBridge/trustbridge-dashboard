/**
 * Maintenance banner API for planned downtime windows.
 *
 * Public read: any caller may fetch active/upcoming windows.
 * Maintainer write: create/update/cancel windows (auth enforced at the route layer).
 *
 * Reason codes are stable and documented in docs/ENVIRONMENT.md.
 */

export type MaintenanceSeverity = "info" | "warning" | "critical";

export type MaintenanceStatus = "upcoming" | "active" | "expired" | "cancelled";

export interface MaintenanceWindow {
  id: string;
  message: string;
  startsAt: string;
  endsAt: string;
  severity: MaintenanceSeverity;
  cancelledAt?: string;
}

export interface MaintenanceWindowView extends MaintenanceWindow {
  status: MaintenanceStatus;
}

export type MaintenanceReasonCode =
  | "missing_message"
  | "message_too_long"
  | "invalid_timestamp"
  | "end_before_start"
  | "invalid_severity"
  | "missing_id"
  | "not_found"
  | "already_cancelled";

export interface MaintenanceError {
  ok: false;
  code: MaintenanceReasonCode;
  message: string;
}

export interface MaintenanceOk<T> {
  ok: true;
  value: T;
}

export type MaintenanceResult<T> = MaintenanceOk<T> | MaintenanceError;

export const MAX_MESSAGE_LENGTH = 280;

const SEVERITIES: readonly MaintenanceSeverity[] = ["info", "warning", "critical"];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function fail(code: MaintenanceReasonCode, message: string): MaintenanceError {
  return { ok: false, code, message };
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_8601.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate a maintenance window input. Returns a normalized window or a stable
 * reason code describing the first failure.
 */
export function validateWindow(input: unknown): MaintenanceResult<MaintenanceWindow> {
  if (typeof input !== "object" || input === null) {
    return fail("missing_message", "maintenance window must be an object");
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    return fail("missing_id", "id is required");
  }
  if (typeof raw.message !== "string" || raw.message.trim() === "") {
    return fail("missing_message", "message is required");
  }
  if (raw.message.length > MAX_MESSAGE_LENGTH) {
    return fail("message_too_long", `message must be <= ${MAX_MESSAGE_LENGTH} characters`);
  }

  const severity = raw.severity ?? "info";
  if (typeof severity !== "string" || !SEVERITIES.includes(severity as MaintenanceSeverity)) {
    return fail("invalid_severity", `severity must be one of ${SEVERITIES.join(", ")}`);
  }

  const startMs = parseTimestamp(raw.startsAt);
  if (startMs === null) {
    return fail("invalid_timestamp", "startsAt must be an ISO-8601 timestamp");
  }
  const endMs = parseTimestamp(raw.endsAt);
  if (endMs === null) {
    return fail("invalid_timestamp", "endsAt must be an ISO-8601 timestamp");
  }
  if (endMs <= startMs) {
    return fail("end_before_start", "endsAt must be after startsAt");
  }

  return {
    ok: true,
    value: {
      id: raw.id.trim(),
      message: raw.message.trim(),
      startsAt: raw.startsAt as string,
      endsAt: raw.endsAt as string,
      severity: severity as MaintenanceSeverity,
      ...(typeof raw.cancelledAt === "string" ? { cancelledAt: raw.cancelledAt } : {}),
    },
  };
}

/** Compute the status of a window relative to `now`. */
export function windowStatus(window: MaintenanceWindow, now: Date = new Date()): MaintenanceStatus {
  if (window.cancelledAt) return "cancelled";
  const nowMs = now.getTime();
  const startMs = Date.parse(window.startsAt);
  const endMs = Date.parse(window.endsAt);
  if (nowMs < startMs) return "upcoming";
  if (nowMs >= endMs) return "expired";
  return "active";
}

/** Decorate windows with their computed status. */
export function withStatus(
  windows: readonly MaintenanceWindow[],
  now: Date = new Date(),
): MaintenanceWindowView[] {
  return windows.map((w) => ({ ...w, status: windowStatus(w, now) }));
}

/**
 * Public read: return active and upcoming windows, sorted by start time.
 * Expired and cancelled windows are omitted from the public banner feed.
 */
export function publicWindows(
  windows: readonly MaintenanceWindow[],
  now: Date = new Date(),
): MaintenanceWindowView[] {
  return withStatus(windows, now)
    .filter((w) => w.status === "active" || w.status === "upcoming")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** Create a window, rejecting duplicates by id (idempotent on identical input). */
export function createWindow(
  windows: readonly MaintenanceWindow[],
  input: unknown,
): MaintenanceResult<MaintenanceWindow[]> {
  const validated = validateWindow(input);
  if (!validated.ok) return validated;
  const existing = windows.find((w) => w.id === validated.value.id);
  if (existing) {
    const same =
      existing.message === validated.value.message &&
      existing.startsAt === validated.value.startsAt &&
      existing.endsAt === validated.value.endsAt &&
      existing.severity === validated.value.severity;
    if (same) return { ok: true, value: [...windows] };
    return fail("missing_id", `window ${validated.value.id} already exists`);
  }
  return { ok: true, value: [...windows, validated.value] };
}

/** Cancel a window by id. Idempotent: cancelling an already-cancelled window is a no-op. */
export function cancelWindow(
  windows: readonly MaintenanceWindow[],
  id: string,
  now: Date = new Date(),
): MaintenanceResult<MaintenanceWindow[]> {
  const idx = windows.findIndex((w) => w.id === id);
  if (idx === -1) return fail("not_found", `window ${id} not found`);
  const target = windows[idx];
  if (target.cancelledAt) return { ok: true, value: [...windows] };
  const next = [...windows];
  next[idx] = { ...target, cancelledAt: now.toISOString() };
  return { ok: true, value: next };
}
