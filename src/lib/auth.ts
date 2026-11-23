import { NextRequest } from "next/server";

export type Role = "contributor" | "maintainer" | "admin";

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
  orgs: string[];
}

export interface AuthResult {
  ok: boolean;
  user?: SessionUser;
  error?: string;
  status?: number;
}

const MAINTAINER_ROLES: Role[] = ["maintainer", "admin"];

/**
 * Resolve the authenticated user from the request.
 *
 * The dashboard trusts the upstream session header set by the auth proxy.
 * When the header is absent the request is treated as unauthenticated.
 */
export function getSessionUser(req: NextRequest): SessionUser | null {
  const raw = req.headers.get("x-session-user");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionUser>;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.login !== "string") {
      return null;
    }
    const role: Role =
      parsed.role === "admin" || parsed.role === "maintainer" ? parsed.role : "contributor";
    const orgs = Array.isArray(parsed.orgs)
      ? parsed.orgs.filter((o): o is string => typeof o === "string")
      : [];
    return { id: parsed.id, login: parsed.login, role, orgs };
  } catch {
    return null;
  }
}

/**
 * Require an authenticated session. Returns a stable error payload when the
 * caller is not signed in so route handlers can respond consistently.
 */
export function requireUser(req: NextRequest): AuthResult {
  const user = getSessionUser(req);
  if (!user) {
    return { ok: false, error: "unauthenticated", status: 401 };
  }
  return { ok: true, user };
}

/**
 * Whether the user holds a maintainer-level role.
 */
export function isMaintainer(user: SessionUser | null | undefined): boolean {
  if (!user) return false;
  return MAINTAINER_ROLES.includes(user.role);
}

/**
 * Whether the user is a maintainer scoped to the given org.
 *
 * Maintainers are org-scoped: a maintainer of org A cannot triage disputes
 * belonging to org B. Admins are treated as global maintainers.
 */
export function isMaintainerForOrg(
  user: SessionUser | null | undefined,
  org: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role !== "maintainer") return false;
  if (!org) return false;
  return user.orgs.includes(org);
}

/**
 * Require maintainer privileges for a dispute transition, honoring org scope.
 *
 * Contributors may only open disputes; triage/resolve/reject transitions are
 * restricted to maintainers of the dispute's org. Returns stable reason codes
 * (`unauthenticated`, `forbidden`) so callers can surface actionable errors.
 */
export function requireMaintainer(
  req: NextRequest,
  org: string | null | undefined,
): AuthResult {
  const auth = requireUser(req);
  if (!auth.ok) return auth;
  if (!isMaintainerForOrg(auth.user, org)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  return auth;
}

/**
 * Session fixation hardening.
 *
 * The dashboard trusts the upstream auth proxy for identity, but the session
 * identifier itself must be rotated whenever privilege context changes
 * (login, org-switch). A pre-set/fixated identifier must never survive a
 * privilege transition, otherwise an attacker who planted a session id could
 * ride the victim's authenticated session.
 *
 * These helpers are pure so they can be unit-tested without a live proxy and
 * reused by `src/lib/api-auth.ts` route handlers.
 */
export type SessionRotationReason = "login" | "org-switch";

export interface SessionRotationResult {
  ok: boolean;
  /** Newly minted session identifier; only present on success. */
  sessionId?: string;
  /** Stable reason code for failures so callers can surface actionable errors. */
  error?: "missing-session" | "invalid-session" | "rotation-failed" | "forbidden";
  status?: number;
}

const SESSION_ID_HEADER = "x-session-id";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Read and validate the current session identifier from the request.
 * Returns `null` when the header is absent or malformed so callers can fail
 * closed with a stable reason code.
 */
export function getSessionId(req: NextRequest): string | null {
  const raw = req.headers.get(SESSION_ID_HEADER);
  if (!raw) return null;
  if (!SESSION_ID_PATTERN.test(raw)) return null;
  return raw;
}

/**
 * Mint a fresh session identifier. Uses the platform CSPRNG; never derived
 * from the previous identifier so a fixated value cannot be predicted.
 */
export function mintSessionId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Rotate the session identifier for a privilege transition.
 *
 * - `login`: requires a valid pre-auth session id; the old id is invalidated
 *   by the caller persisting the new id and rejecting the old one.
 * - `org-switch`: additionally requires the user to be a member of the target
 *   org (admins are global), otherwise returns `forbidden`.
 *
 * Returns stable reason codes (`missing-session`, `invalid-session`,
 * `rotation-failed`, `forbidden`) so route handlers can respond consistently.
 */
export function rotateSession(
  req: NextRequest,
  reason: SessionRotationReason,
  targetOrg?: string | null,
): SessionRotationResult {
  const current = getSessionId(req);
  if (!current) {
    const raw = req.headers.get(SESSION_ID_HEADER);
    return {
      ok: false,
      error: raw ? "invalid-session" : "missing-session",
      status: 401,
    };
  }

  if (reason === "org-switch") {
    const user = getSessionUser(req);
    if (!user) {
      return { ok: false, error: "invalid-session", status: 401 };
    }
    if (!isMaintainerForOrg(user, targetOrg) && !user.orgs.includes(targetOrg ?? "")) {
      return { ok: false, error: "forbidden", status: 403 };
    }
  }

  let next: string;
  try {
    next = mintSessionId();
  } catch {
    return { ok: false, error: "rotation-failed", status: 500 };
  }
  if (!next || next === current) {
    return { ok: false, error: "rotation-failed", status: 500 };
  }
  return { ok: true, sessionId: next };
}
