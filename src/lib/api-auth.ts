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
 * GraphQL abuse-protection limits. These bound the cost of a single GraphQL
 * operation so a deeply nested or wide query cannot be used as a cheap DoS
 * against the Wave dashboard during traffic spikes.
 *
 * Operators can override the defaults via environment variables:
 * - `GRAPHQL_MAX_DEPTH` (default 10)
 * - `GRAPHQL_MAX_COMPLEXITY` (default 1000)
 *
 * Introspection is disabled in production unless `GRAPHQL_ALLOW_INTROSPECTION`
 * is set to `"true"` (useful for trusted tooling).
 */
export const GRAPHQL_DEFAULT_MAX_DEPTH = 10;
export const GRAPHQL_DEFAULT_MAX_COMPLEXITY = 1000;

/**
 * Stable reason codes returned when a GraphQL operation is rejected by the
 * abuse-protection limits. Documented in `docs/ARCHITECTURE.md`.
 */
export type GraphQLLimitReasonCode =
  | "graphql_depth_exceeded"
  | "graphql_complexity_exceeded"
  | "graphql_introspection_disabled";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolve the effective GraphQL depth/complexity limits from the environment,
 * falling back to the documented defaults when unset or invalid.
 */
export function getGraphQLLimits(): { maxDepth: number; maxComplexity: number } {
  return {
    maxDepth: readPositiveIntEnv("GRAPHQL_MAX_DEPTH", GRAPHQL_DEFAULT_MAX_DEPTH),
    maxComplexity: readPositiveIntEnv(
      "GRAPHQL_MAX_COMPLEXITY",
      GRAPHQL_DEFAULT_MAX_COMPLEXITY
    ),
  };
}

/**
 * Whether GraphQL introspection is permitted. Disabled in production unless
 * explicitly opted in via `GRAPHQL_ALLOW_INTROSPECTION=true`; always allowed
 * outside production so local tooling keeps working.
 */
export function isGraphQLIntrospectionAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.GRAPHQL_ALLOW_INTROSPECTION?.trim().toLowerCase() === "true";
}

/**
 * Extract the org-scope identifier from a session.
 *
 * Returns `session.user.maintainerOrgId` when present (set by the JWT
 * callback for all sessions created after the multi-org migration).  Falls
 * back to `"default"` for older sessions that pre-date the field so every
 * downstream query has a stable, non-null value to filter on.
 *
 * Usage:
 *   const orgId = getMaintainerOrgId(session);
 *   // then pass to prisma: where: { maintainerOrgId: orgId }
 */
export function getMaintainerOrgId(session: Session | null): string {
  if (!session?.user) return "default";
  const orgId = (session.user as Record<string, unknown>).maintainerOrgId;
  if (typeof orgId === "string" && orgId.trim().length > 0) {
    return orgId.trim();
  }
  return "default";
}

export { hasMinimumRole, ROLE_HIERARCHY };
