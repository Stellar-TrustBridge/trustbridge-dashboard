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
 * Maximum number of concurrent sessions a single user may hold.
 *
 * Maintainers and admins are capped tighter than contributors because an
 * unlimited number of live maintainer sessions increases takeover
 * persistence. See docs/SESSIONS.md for the full policy.
 */
export const MAX_CONCURRENT_SESSIONS: Record<Role, number> = {
  contributor: 10,
  maintainer: 5,
  admin: 3,
};

/**
 * Notification digest cadence. `weekly` is the safe default for new users so
 * Wave contributors are not flooded with mail on day one.
 */
export type DigestFrequency = "off" | "daily" | "weekly";

/**
 * Notification preferences seeded for a brand-new user.
 *
 * Defaults are intentionally conservative: a weekly digest and dispute
 * notifications on, everything else off. See docs/DIGEST.md.
 */
export interface NotificationPreferences {
  digest: DigestFrequency;
  disputes: boolean;
  mentions: boolean;
  releases: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = {
  digest: "weekly",
  disputes: true,
  mentions: false,
  releases: false,
};

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
 * The per-role concurrent session cap for a user.
 */
export function maxSessionsForRole(role: Role): number {
  return MAX_CONCURRENT_SESSIONS[role] ?? MAX_CONCURRENT_SESSIONS.contributor;
}

/**
 * Whether a user may open another concurrent session given the number of
 * sessions they currently hold. Returns a stable reason code
 * (`session_limit_exceeded`) when the cap is reached so route handlers can
 * surface an actionable error instead of silently succeeding.
 *
 * Org switching does not create a new session and therefore does not count
 * against the limit; see docs/SESSIONS.md.
 */
export function checkSessionLimit(
  user: SessionUser | null | undefined,
  activeSessions: number,
): AuthResult {
  if (!user) {
    return { ok: false, error: "unauthenticated", status: 401 };
  }
  if (!Number.isFinite(activeSessions) || activeSessions < 0) {
    return { ok: false, error: "invalid_session_count", status: 400 };
  }
  if (activeSessions >= maxSessionsForRole(user.role)) {
    return { ok: false, error: "session_limit_exceeded", status: 429 };
  }
  return { ok: true, user };
}

/**
 * Seed notification preferences for a brand-new user.
 *
 * Returns a fresh copy of the safe defaults (weekly digest, disputes on) so
 * callers can persist them without mutating the shared constant. Existing
 * preferences are never overwritten: pass them as `existing` and they are
 * returned unchanged, keeping repeated invocations idempotent.
 */
export function seedNotificationPreferences(
  existing?: Partial<NotificationPreferences> | null,
): NotificationPreferences {
  if (existing && typeof existing === "object") {
    return {
      digest: existing.digest ?? DEFAULT_NOTIFICATION_PREFERENCES.digest,
      disputes: existing.disputes ?? DEFAULT_NOTIFICATION_PREFERENCES.disputes,
      mentions: existing.mentions ?? DEFAULT_NOTIFICATION_PREFERENCES.mentions,
      releases: existing.releases ?? DEFAULT_NOTIFICATION_PREFERENCES.releases,
    };
  }
  return { ...DEFAULT_NOTIFICATION_PREFERENCES };
}
