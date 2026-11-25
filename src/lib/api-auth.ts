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
 * Stable reason codes emitted by {@link rotateSession} so callers can map
 * failures to consistent HTTP responses and audit metadata.
 */
export type SessionRotationReasonCode =
  | "rotated"
  | "missing_pre_auth_session"
  | "invalid_pre_auth_session"
  | "org_switch_denied"
  | "rotation_persist_failed";

export interface SessionRotationResult {
  ok: boolean;
  /** Stable reason code describing the outcome. */
  reason: SessionRotationReasonCode;
  /** The freshly rotated session when `ok` is true. */
  session: Session | null;
  /** The identifier of the pre-rotation session, when one was present. */
  previousSessionId: string | null;
  /** The identifier of the post-rotation session, when rotation succeeded. */
  sessionId: string | null;
}

/**
 * Persist a rotated session identifier. Supplied by the caller (typically the
 * auth route handler) so this module stays free of a circular dependency on
 * `src/lib/auth.ts` while keeping rotation semantics in one place.
 *
 * Implementations MUST invalidate the previous identifier before returning so
 * a fixated identifier can never be replayed. Returning `false` signals a
 * persistence failure and the caller must treat the login as failed.
 */
export type SessionRotationPersister = (params: {
  previousSessionId: string | null;
  session: Session;
  reason: "login" | "org-switch";
}) => Promise<boolean>;

/**
 * Rotate the session identifier on login and org-switch to defeat session
 * fixation. A pre-set/fixated identifier is invalidated before the new one is
 * issued, so it can never be reused after a successful rotation.
 *
 * Failure paths (all return `ok: false` with a stable reason code and never
 * leave partial privileged state):
 * - `missing_pre_auth_session`: no session was presented to rotate.
 * - `invalid_pre_auth_session`: the presented session is not a maintainer.
 * - `org_switch_denied`: org-switch requested without valid membership.
 * - `rotation_persist_failed`: the persister failed to invalidate/issue.
 */
export async function rotateSession(
  persist: SessionRotationPersister,
  options: { reason: "login" | "org-switch"; orgId?: string | null } = { reason: "login" }
): Promise<SessionRotationResult> {
  const session = await getServerSession(authOptions);
  const previousSessionId = session?.user?.id ?? null;

  if (!session) {
    return {
      ok: false,
      reason: "missing_pre_auth_session",
      session: null,
      previousSessionId: null,
      sessionId: null,
    };
  }

  if (!session.user?.isMaintainer) {
    return {
      ok: false,
      reason: "invalid_pre_auth_session",
      session: null,
      previousSessionId,
      sessionId: null,
    };
  }

  if (options.reason === "org-switch") {
    const memberships = (session.user as { orgIds?: string[] }).orgIds ?? [];
    if (!options.orgId || !memberships.includes(options.orgId)) {
      await recordAuditLog({
        action: "session_rotation_denied",
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
        metadata: { reason: "org_switch_denied", orgId: options.orgId ?? null },
      });
      return {
        ok: false,
        reason: "org_switch_denied",
        session: null,
        previousSessionId,
        sessionId: null,
      };
    }
  }

  const persisted = await persist({
    previousSessionId,
    session,
    reason: options.reason,
  });

  if (!persisted) {
    await recordAuditLog({
      action: "session_rotation_failed",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      metadata: { reason: "rotation_persist_failed", rotationReason: options.reason },
    });
    return {
      ok: false,
      reason: "rotation_persist_failed",
      session: null,
      previousSessionId,
      sessionId: null,
    };
  }

  return {
    ok: true,
    reason: "rotated",
    session,
    previousSessionId,
    sessionId: session.user.id,
  };
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
 * request so a caller cannot exhaust the server with an oversized or deeply
 * nested document. They are enforced by `src/app/api/graphql/route.ts`.
 */
export const GRAPHQL_MAX_QUERY_BYTES = 16 * 1024;
export const GRAPHQL_MAX_DEPTH = 12;

/**
 * Persisted-query allowlist mode for the GraphQL endpoint.
 *
 * When `GRAPHQL_PERSISTED_QUERIES_ONLY` is set to a truthy value (`1`, `true`,
 * `yes`, `on`), the endpoint only accepts queries identified by a persisted
 * query hash that appears in the allowlist. Arbitrary inline queries are
 * rejected. When the env var is unset or falsy, behavior is unchanged and
 * inline queries are accepted (subject to the existing abuse limits).
 *
 * The allowlist is supplied via `GRAPHQL_PERSISTED_QUERY_ALLOWLIST` as a
 * comma-separated list of lowercase hex SHA-256 hashes. Hashes are normalized
 * to lowercase and trimmed; empty entries are ignored.
 */
export type PersistedQueryErrorCode =
  | "persisted_queries_disabled"
  | "missing_query"
  | "invalid_persisted_query_id"
  | "query_too_large"
  | "unknown_persisted_query";

export interface PersistedQueryResult {
  ok: boolean;
  /** Stable error code when `ok` is false. */
  error?: PersistedQueryErrorCode;
  /** The normalized persisted-query hash when one was accepted. */
  hash?: string;
}

const PERSISTED_QUERY_HASH_RE = /^[a-f0-9]{64}$/;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Whether persisted-query allowlist mode is enabled for this process.
 */
export function isPersistedQueryModeEnabled(): boolean {
  return isTruthyEnv(process.env.GRAPHQL_PERSISTED_QUERIES_ONLY);
}

/**
 * Parse the configured persisted-query allowlist into a normalized set of
 * lowercase SHA-256 hashes. Malformed entries are dropped so a typo cannot
 * silently widen the allowlist.
 */
export function getPersistedQueryAllowlist(): Set<string> {
  const raw = process.env.GRAPHQL_PERSISTED_QUERY_ALLOWLIST ?? "";
  const hashes = new Set<string>();
  for (const entry of raw.split(",")) {
    const normalized = entry.trim().toLowerCase();
    if (PERSISTED_QUERY_HASH_RE.test(normalized)) {
      hashes.add(normalized);
    }
  }
  return hashes;
}

/**
 * Enforce persisted-query allowlist mode for a GraphQL request body.
 *
 * Returns `{ ok: true }` when the mode is disabled (default behavior is
 * unchanged) or when the supplied persisted-query hash is present in the
 * allowlist. Returns a stable error code otherwise. This check is purely
 * additive: callers must still run auth, CSRF, org-scope, pause/freeze, and
 * dry-run checks before executing the query.
 */
export function enforcePersistedQueryAllowlist(input: {
  query?: unknown;
  persistedQueryId?: unknown;
}): PersistedQueryResult {
  if (!isPersistedQueryModeEnabled()) {
    return { ok: true };
  }

  const rawId = input.persistedQueryId;
  const hasId = typeof rawId === "string" && rawId.trim().length > 0;

  if (!hasId) {
    // No persisted-query id: inline queries are not allowed in this mode.
    if (typeof input.query === "string" && input.query.length > GRAPHQL_MAX_QUERY_BYTES) {
      return { ok: false, error: "query_too_large" };
    }
    if (typeof input.query === "string" && input.query.trim().length > 0) {
      return { ok: false, error: "unknown_persisted_query" };
    }
    return { ok: false, error: "missing_query" };
  }

  const normalized = (rawId as string).trim().toLowerCase();
  if (!PERSISTED_QUERY_HASH_RE.test(normalized)) {
    return { ok: false, error: "invalid_persisted_query_id" };
  }

  const allowlist = getPersistedQueryAllowlist();
  if (!allowlist.has(normalized)) {
    return { ok: false, error: "unknown_persisted_query" };
  }

  return { ok: true, hash: normalized };
}
