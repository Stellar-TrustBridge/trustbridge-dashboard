import { NextRequest } from "next/server";
import type { AppRole } from "@/types";

export type Role = "contributor" | "maintainer" | "admin";

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
  orgs: string[];
  /**
   * Fine-grained RBAC role for maintainer actions.
   * Present when the upstream auth proxy sets it; absent for contributors.
   * Hierarchy: admin > operator > viewer (see src/lib/maintainers.ts).
   */
  appRole?: AppRole;
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
    const parsed = JSON.parse(raw) as Partial<SessionUser & { appRole?: string }>;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.login !== "string") {
      return null;
    }
    const role: Role =
      parsed.role === "admin" || parsed.role === "maintainer" ? parsed.role : "contributor";
    const orgs = Array.isArray(parsed.orgs)
      ? parsed.orgs.filter((o): o is string => typeof o === "string")
      : [];
    const appRole: AppRole | undefined =
      parsed.appRole === "admin" || parsed.appRole === "operator" || parsed.appRole === "viewer"
        ? (parsed.appRole as AppRole)
        : undefined;
    return { id: parsed.id, login: parsed.login, role, orgs, appRole };
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
 * Require a maintainer with a minimum AppRole level for role-gated actions.
 *
 * Uses the same `canBan` / `canInvite` / `canRestoreRegistration` /
 * `canChangeNetworkSettings` predicates from `src/lib/maintainers.ts`
 * so the permission table stays in one place.
 *
 * Returns stable reason codes:
 *   `unauthenticated` — no session
 *   `forbidden`       — authenticated but insufficient role
 *   `role_required`   — maintainer but appRole missing or too low
 *
 * @param req        The incoming NextRequest.
 * @param predicate  A permission predicate from `src/lib/maintainers.ts`
 *                   e.g. `canBan`, `canInvite`.
 */
export function requireMaintainerWithRole(
  req: NextRequest,
  predicate: (role: AppRole | string | undefined | null) => boolean,
): AuthResult {
  const auth = requireUser(req);
  if (!auth.ok) return auth;
  const user = auth.user!;
  if (!isMaintainer(user)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  if (!predicate(user.appRole)) {
    return { ok: false, error: "role_required", status: 403 };
  }
  return auth;
}
