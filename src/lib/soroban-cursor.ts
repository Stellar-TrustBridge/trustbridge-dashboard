/**
 * Soroban event cursor validation.
 *
 * Cursors are opaque paging tokens returned by `GET /api/soroban/events` in
 * the `nextCursor` field.  They are decimal ledger sequence numbers optionally
 * separated from an event-index by a hyphen:
 *
 *   "12345"           — ledger only (page break after ledger 12345)
 *   "12345-3"         — ledger + event index within that ledger
 *
 * The validation layer intentionally stays loose: a cursor is valid when it is
 * a non-empty string containing only decimal digits and an optional single
 * hyphen separator whose parts are both non-empty digit sequences.  This
 * covers every format the Soroban RPC has historically returned and leaves
 * room for future token shapes.
 *
 * Invalid cursors return 400 with a stable `code: "INVALID_CURSOR"` body so
 * callers can distinguish cursor errors from auth errors and retry safely.
 */

/** Maximum byte length accepted for a cursor string. */
export const SOROBAN_CURSOR_MAX_LENGTH = 128;

/** Stable error code returned in the 400 body for bad cursors. */
export const INVALID_CURSOR_CODE = "INVALID_CURSOR";

/**
 * Result of {@link parseSorobanEventCursor}.
 *
 * - `ok: true`  — `cursor` is the validated, trimmed cursor ready for the RPC.
 * - `ok: false` — `reason` is a human-readable explanation for the 400 body.
 */
export type SorobanCursorParseResult =
  | { ok: true; cursor: string }
  | { ok: false; reason: string };

/**
 * Allowed cursor pattern: one or two segments of digits separated by a single
 * hyphen.  Examples: `"0"`, `"12345"`, `"12345-3"`.
 */
const CURSOR_PATTERN = /^\d+(-\d+)?$/;

/**
 * Validate and normalise a raw cursor string from the query parameter.
 *
 * Returns `{ ok: true, cursor }` on success, `{ ok: false, reason }` for any
 * structural defect.  Never throws.
 */
export function parseSorobanEventCursor(raw: unknown): SorobanCursorParseResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "cursor must be a string" };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "cursor must not be empty" };
  }

  if (trimmed.length > SOROBAN_CURSOR_MAX_LENGTH) {
    return {
      ok: false,
      reason: `cursor exceeds maximum length of ${SOROBAN_CURSOR_MAX_LENGTH} characters`,
    };
  }

  if (!CURSOR_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason:
        "cursor must be a decimal ledger sequence number (e.g. \"12345\") or a ledger-event pair (e.g. \"12345-3\")",
    };
  }

  return { ok: true, cursor: trimmed };
}

/**
 * Build the stable 400 response body for a failed cursor parse.
 *
 * Shape mirrors the existing `buildInvalidCursorError` contract used by
 * `src/lib/cursor-pagination.ts` so API consumers can handle both errors
 * with a single code path.
 */
export function buildInvalidCursorError(raw: string): {
  error: string;
  code: typeof INVALID_CURSOR_CODE;
  message: string;
  remediation: string;
} {
  const truncated =
    raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  return {
    error: "Invalid cursor",
    code: INVALID_CURSOR_CODE,
    message: `The cursor "${truncated}" is not a valid Soroban event cursor.`,
    remediation:
      "Omit the cursor parameter to fetch the latest event window, or use the " +
      "nextCursor value returned by a previous response.",
  };
}
