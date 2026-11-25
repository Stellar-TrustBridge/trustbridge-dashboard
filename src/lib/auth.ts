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
 * Redaction mode for address-history exports.
 *
 * - `self`: the caller may only see their own addresses; other parties are
 *   fully masked.
 * - `admin`: maintainers/admins may see the full history, but sensitive
 *   addresses are still masked per the documented masking policy.
 */
export type RedactionMode = "self" | "admin";

/**
 * Derive the address-history redaction mode from the authenticated role.
 *
 * Maintainers and admins get `admin` mode; everyone else (including
 * unauthenticated callers, which callers must reject before use) gets the
 * least-privileged `self` mode. This keeps the decision centralized so the
 * route handler and library stay consistent.
 */
export function getRedactionMode(user: SessionUser | null | undefined): RedactionMode {
  return isMaintainer(user) ? "admin" : "self";
}

/**
 * Require maintainer privileges for mutating the address-anomaly allowlist.
 *
 * The allowlist is maintainer-only. Admins are global maintainers; a
 * maintainer must be scoped to the given org (the allowlist's owning org).
 * Reuses the same org-scope rules as `requireMaintainer` so the allowlist
 * does not introduce a parallel auth subsystem. Returns stable reason codes
 * (`unauthenticated`, `forbidden`) for actionable errors.
 */
export function requireAllowlistMaintainer(
  req: NextRequest,
  org: string | null | undefined,
): AuthResult {
  return requireMaintainer(req, org);
}
