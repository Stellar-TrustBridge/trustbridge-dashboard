import "server-only";

import { getServerSession, type Session } from "next-auth";

import { authOptions } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import type { AppRole } from "@/types";

/**
 * Role hierarchy: admin > operator > viewer.
 * A user with a higher role implicitly has lower-role permissions.
 */
const ROLE_HIERARCHY: Record<AppRole, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

function hasMinimumRole(userRole: AppRole | undefined, minimum: AppRole): boolean {
  if (!userRole) return false;
  return (ROLE_HIERARCHY[userRole] ?? 0) >= ROLE_HIERARCHY[minimum];
}

/**
 * Authorizes scheduler-triggered requests (e.g. Vercel Cron) that carry no
 * maintainer session. Requires `CRON_SECRET` to be configured — with it
 * unset, only maintainers can trigger the action.
 */
export function isAuthorizedScheduler(
  request: Request | { headers: Headers | { get(name: string): string | null } }
): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authHeader =
    request.headers instanceof Headers
      ? request.headers.get("authorization")
      : typeof request.headers.get === "function"
      ? request.headers.get("authorization")
      : null;
  return authHeader === `Bearer ${secret}`;
}

/**
 * Return the current session only when the user is a maintainer, otherwise
 * null. Shared by every maintainer-only API route.
 */
export async function requireMaintainerSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isMaintainer) {
  return null;
  }
  return session;
}

/**
 * Require a minimum RBAC role. Falls back to maintainer check for backwards
 * compatibility: existing maintainers without an explicit role get "viewer".
 *
 * Returns the session if the role requirement is met, otherwise null.
 * Records an audit log on denial.
 */
export async function requireRole(
  minimumRole: AppRole,
  action?: string
): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isMaintainer) return null;

  const userRole = (session.user.role as AppRole | undefined) ?? "viewer";

  if (hasMinimumRole(userRole, minimumRole)) {
    return session;
  }

  // Audit the denial
  await recordAuditLog({
    action: "rbac_access_denied",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      requiredRole: minimumRole,
      actualRole: userRole,
      action: action ?? "unknown",
    },
  });

  return null;
}

/**
 * Convenience: require operator role or higher.
 */
export async function requireOperator(action?: string): Promise<Session | null> {
  return requireRole("operator", action);
}

/**
 * Convenience: require admin role.
 */
export async function requireAdmin(action?: string): Promise<Session | null> {
  return requireRole("admin", action);
}

/**
 * Refresh the maintainer session. This re-evaluates the current server session
 * and returns it if the user is still a maintainer. It can be used by UI
 * components or API routes that need to ensure the maintainer flag is up-to-date
 * without forcing the user to re-login.
 */
export async function refreshMaintainerSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (session?.user?.isMaintainer) {
    return session;
  }
  return null;
}

/**
 * Credential kinds a request may present to a dual-auth route.
 */
export type ApiCredentialKind = "session" | "api-key" | "none";

/**
 * Explicit matrix of allowed credential combinations for routes that accept
 * either a maintainer session or an API key.
 *
 * - `session-only`: only a maintainer session is accepted.
 * - `api-key-only`: only an API key is accepted.
 * - `either`: exactly one of the two is accepted.
 * - `both`: both credentials must be present and valid.
 *
 * Presenting both credentials when the route allows only one is treated as a
 * conflict and rejected, so a request can never silently fall back from one
 * credential to the other.
 */
export type DualAuthMode = "session-only" | "api-key-only" | "either" | "both";

/**
 * Stable error codes returned by {@link resolveDualAuth} so callers can map
 * failures to consistent HTTP responses.
 */
export type DualAuthErrorCode =
  | "missing_credentials"
  | "conflicting_credentials"
  | "invalid_session"
  | "invalid_api_key";

export interface DualAuthResult {
  ok: boolean;
  /** Which credential kinds were present on the request. */
  presented: ApiCredentialKind[];
  /** The maintainer session when a session credential was accepted. */
  session: Session | null;
  /** Stable error code when `ok` is false. */
  error?: DualAuthErrorCode;
}

/**
 * Detect which credential kinds a request presents. An API key is detected by
 * the presence of an `Authorization: Bearer <token>` header that is not the
 * scheduler secret; a session is detected by a maintainer session.
 */
export async function detectCredentials(
  request: Request | { headers: Headers | { get(name: string): string | null } }
): Promise<{ presented: ApiCredentialKind[]; session: Session | null; hasApiKey: boolean }> {
  const authHeader =
    request.headers instanceof Headers
      ? request.headers.get("authorization")
      : typeof request.headers.get === "function"
      ? request.headers.get("authorization")
      : null;

  const hasApiKey = Boolean(authHeader && /^Bearer\s+\S+/i.test(authHeader));
  const session = await requireMaintainerSession();

  const presented: ApiCredentialKind[] = [];
  if (session) presented.push("session");
  if (hasApiKey) presented.push("api-key");
  if (presented.length === 0) presented.push("none");

  return { presented, session, hasApiKey };
}

/**
 * Enforce the dual-auth matrix for a route. `verifyApiKey` is supplied by the
 * caller (typically from `src/lib/api-key-auth.ts`) so this module stays free
 * of a circular dependency while keeping the matrix in one place.
 *
 * Returns a {@link DualAuthResult}; callers should respond with a stable error
 * derived from `error` when `ok` is false.
 */
export async function resolveDualAuth(
  request: Request | { headers: Headers | { get(name: string): string | null } },
  mode: DualAuthMode,
  verifyApiKey: (request: Request | { headers: Headers | { get(name: string): string | null } }) => Promise<boolean>
): Promise<DualAuthResult> {
  const { presented, session, hasApiKey } = await detectCredentials(request);
  const hasSession = session !== null;

  if (!hasSession && !hasApiKey) {
    return { ok: false, presented, session: null, error: "missing_credentials" };
  }

  if (mode === "session-only") {
    if (hasApiKey) {
      return { ok: false, presented, session: null, error: "conflicting_credentials" };
    }
    return { ok: true, presented, session };
  }

  if (mode === "api-key-only") {
    if (hasSession) {
      return { ok: false, presented, session: null, error: "conflicting_credentials" };
    }
    const valid = await verifyApiKey(request);
    return valid
      ? { ok: true, presented, session: null }
      : { ok: false, presented, session: null, error: "invalid_api_key" };
  }

  if (mode === "either") {
    if (hasSession && hasApiKey) {
      return { ok: false, presented, session: null, error: "conflicting_credentials" };
    }
    if (hasSession) {
      return { ok: true, presented, session };
    }
    const valid = await verifyApiKey(request);
    return valid
      ? { ok: true, presented, session: null }
      : { ok: false, presented, session: null, error: "invalid_api_key" };
  }

  // mode === "both"
  if (!hasSession) {
    return { ok: false, presented, session: null, error: "invalid_session" };
  }
  const valid = await verifyApiKey(request);
  return valid
    ? { ok: true, presented, session }
    : { ok: false, presented, session: null, error: "invalid_api_key" };
}

/**
 * Stable reason codes returned by {@link enforceInviteRateLimit} so the invites
 * generate route can map failures to consistent HTTP responses.
 */
export type InviteRateLimitReason =
  | "rate_limited"
  | "invalid_actor";

export interface InviteRateLimitResult {
  ok: boolean;
  /** Remaining generations allowed in the current window. */
  remaining: number;
  /** Milliseconds until the window resets (0 when not limited). */
  retryAfterMs: number;
  /** Stable reason code when `ok` is false. */
  reason?: InviteRateLimitReason;
}

interface InviteRateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * Default invite-generation budget: 10 tokens per actor per 60s window.
 * Overridable via `INVITE_GENERATE_RATE_LIMIT` (max generations) and
 * `INVITE_GENERATE_RATE_WINDOW_MS` (window length) for operators.
 */
const DEFAULT_INVITE_LIMIT = 10;
const DEFAULT_INVITE_WINDOW_MS = 60_000;

const inviteRateLimitBuckets = new Map<string, InviteRateLimitBucket>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reset the in-memory invite rate-limit state. Exposed for tests only.
 */
export function resetInviteRateLimit(): void {
  inviteRateLimitBuckets.clear();
}

/**
 * Enforce a per-actor sliding-window rate limit on invite generation. This
 * resists token enumeration and abuse of the generate route. The actor key is
 * the maintainer's stable user id; requests without one are rejected with
 * `invalid_actor` so anonymous callers can never consume the budget.
 *
 * The limiter is process-local (best-effort) and intentionally dependency-free
 * to match the existing route patterns; operators behind multiple instances
 * should also front the route with an edge rate limiter.
 */
export function enforceInviteRateLimit(
  actorId: string | null | undefined,
  now: number = Date.now()
): InviteRateLimitResult {
  const limit = readPositiveIntEnv("INVITE_GENERATE_RATE_LIMIT", DEFAULT_INVITE_LIMIT);
  const windowMs = readPositiveIntEnv(
    "INVITE_GENERATE_RATE_WINDOW_MS",
    DEFAULT_INVITE_WINDOW_MS
  );

  if (!actorId || typeof actorId !== "string" || actorId.trim().length === 0) {
    return { ok: false, remaining: 0, retryAfterMs: 0, reason: "invalid_actor" };
  }

  const key = actorId.trim();
  const bucket = inviteRateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    inviteRateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, bucket.resetAt - now),
      reason: "rate_limited",
    };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/**
 * GraphQL abuse-protection limits. These bound the cost 