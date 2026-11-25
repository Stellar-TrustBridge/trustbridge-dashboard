import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import { ApiKeyScope, hasApiKeyScope } from "@/lib/api-key-scopes";
import { hashApiKey, isValidApiKeyFormat } from "@/lib/api-key-crypto";
import { prisma } from "@/lib/prisma";
import {
  buildRateLimitHeaders,
  checkRateLimit,
  extractClientIp,
} from "@/lib/rate-limit";

// Re-export so routes that import from this module get the full set of
// rate-limit helpers without a second import.
export { buildRateLimitHeaders } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ApiKeyScope } from "@/lib/api-key-scopes";
export { API_KEY_SCOPES } from "@/lib/api-key-scopes";

/** The subset of the ApiKey row returned to callers after a successful auth. */
export interface AuthenticatedApiKey {
  id: string;
  name: string;
  scopes: string[];
  createdById: string;
  maintainerOrgId: string;
}

/**
 * Stable, machine-readable reasons a dual-auth request is rejected.  Routes
 * map these to HTTP status codes so the session-vs-API-key matrix is
 * deterministic and testable.
 */
export type DualAuthRejection =
  | "missing_credentials"
  | "conflicting_credentials"
  | "malformed_authorization";

/**
 * Result of inspecting a request for the session-vs-API-key credential matrix.
 *
 * - `api_key`  → an `Authorization: Bearer <token>` header is present.
 * - `session`  → no bearer token; caller should fall back to session auth.
 * - `rejected` → the combination is not allowed; return the mapped status.
 */
export type DualAuthMode =
  | { mode: "api_key"; token: string }
  | { mode: "session" }
  | { mode: "rejected"; reason: DualAuthRejection };

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the key's `scopes` list covers `required`.
 * The wildcard scope `"*"` is reserved for internal use and is intentionally
 * not creatable via the UI, but is recognised here for flexibility.
 */
export function hasScope(scopes: string[], required: ApiKeyScope): boolean {
  return hasApiKeyScope(scopes, required);
}

/**
 * Stable, machine-readable reasons an API-key scope check is rejected.
 * Routes map these to HTTP status codes so the least-privilege matrix is
 * deterministic and testable.
 */
export type ApiKeyScopeRejection =
  | "missing_scope"
  | "insufficient_scope";

/**
 * Result of enforcing a required scope on an authenticated key.
 *
 * - `ok`       → the key covers the required scope.
 * - `rejected` → the key is missing the scope; return the mapped status.
 */
export type ApiKeyScopeCheck =
  | { ok: true }
  | { ok: false; reason: ApiKeyScopeRejection; required: ApiKeyScope };

/**
 * Enforce least privilege for a single required scope on an already
 * authenticated key. Export/CSV/JSON routes must call this with an explicit
 * `export:*` scope so read-only keys cannot fall back to broad read/write
 * grants.
 *
 * Returns `{ ok: true }` when the key covers `required`, otherwise a stable
 * rejection reason the route maps to a 403.
 */
export function enforceApiKeyScope(
  key: Pick<AuthenticatedApiKey, "scopes">,
  required: ApiKeyScope
): ApiKeyScopeCheck {
  if (!Array.isArray(key.scopes) || key.scopes.length === 0) {
    return { ok: false, reason: "missing_scope", required };
  }

  if (!hasApiKeyScope(key.scopes, required)) {
    return { ok: false, reason: "insufficient_scope", required };
  }

  return { ok: true };
}

/** Map an API-key scope rejection reason to the HTTP status a route returns. */
export function apiKeyScopeRejectionStatus(reason: ApiKeyScopeRejection): number {
  switch (reason) {
    case "missing_scope":
      return 403;
    case "insufficient_scope":
      return 403;
  }
}

// ---------------------------------------------------------------------------
// Dual-auth matrix
// ---------------------------------------------------------------------------

/**
 * Classify a request against the explicit session-vs-API-key matrix.
 *
 * Allowed combinations:
 * - API-key-only: `Authorization: Bearer <token>` present, no session cookie.
 * - Session-only: no bearer token; caller resolves the session.
 *
 * Rejected combinations:
 * - Both a bearer token and a session cookie are present (ambiguous identity).
 * - A non-empty `Authorization` header that is not a well-formed bearer token.
 *
 * This helper does not touch the DB; it only decides which auth path to take
 * so routes stay consistent with `requireApiKeyScope`.
 */
export function resolveDualAuthMode(request: NextRequest): DualAuthMode {
  const authHeader = request.headers.get("authorization");
  const hasSessionCookie = Boolean(
    request.cookies.get("next-auth.session-token")?.value ||
      request.cookies.get("__Secure-next-auth.session-token")?.value
  );

  if (authHeader === null) {
    return { mode: "session" };
  }

  const trimmed = authHeader.trim();
  if (trimmed === "") {
    return { mode: "session" };
  }

  if (!trimmed.startsWith("Bearer ")) {
    return { mode: "rejected", reason: "malformed_authorization" };
  }

  const token = trimmed.slice(7).trim();
  if (!token) {
    return { mode: "rejected", reason: "malformed_authorization" };
  }

  if (hasSessionCookie) {
    return { mode: "rejected", reason: "conflicting_credentials" };
  }

  return { mode: "api_key", token };
}

/** Map a dual-auth rejection reason to the HTTP status a route should return. */
export function dualAuthRejectionStatus(reason: DualAuthRejection): number {
  switch (reason) {
    case "missing_credentials":
      return 401;
    case "conflicting_credentials":
      return 400;
    case "malformed_authorization":
      return 400;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting constants
// ---------------------------------------------------------------------------

/**
 * API key endpoints are much less latency-sensitive than browser sessions,
 * but we still protect them from brute-force enumeration: 60 requests per
 * minute per IP.  Env vars `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`
 * are the process-wide defaults; these override per-call for export routes.
 *
 * Exported so routes can reference the constant in their own 429 responses
 * rather than hard-coding the value.
 */
export const API_KEY_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 60,
} as const;

// ---------------------------------------------------------------------------
// Main authenticator
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from `Authorization: Bearer <token>`, look it up
 * in the database by its SHA-256 hash, verify the key is active and has the
 * required scope, apply a per-IP rate limit, update `lastUsedAt`, and return
 * the key record.
 *
 * Returns `null` on any auth failure; the caller is responsible for returning
 * a 401/403.  A `RateLimitResult` is returned when the IP is rate-limited so
 * the route can set the appropriate response headers.
 *
 * @example
 * ```ts
 * const auth = await requireApiKeyScope(request, "export:read");
 * if ("rateLimited" in auth) {
 *   return NextResponse.json({ error: "Too many requests" }, {
 *     status: 429,
 *     headers: buildRateLimitHeaders(auth.result, API_KEY_MAX_REQUESTS),
 *   });
 * }
 * if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 * ```
 */
/**
 * Authenticate an API key without enforcing any scope.
 *
 * Runs the same rate-limit, format, lookup, and lifecycle (revoked/expired)
 * checks as {@link requireApiKeyScope}. Returns the key record so the caller
 * can enforce a scope explicitly and return a stable 403 when it is missing.
 * Returns `null` on any auth failure; the caller is responsible for returning
 * a 401. A `RateLimitResult` is returned when the IP is rate-limited.
 */
export async function authenticateApiKey(
  request: NextRequest
): Promise<
  | AuthenticatedApiKey
  | { rateLimited: true; result: { allowed: false; retryAfter: number; remaining: number } }
  | null
> {
  // ── 1. Rate-limit by IP before touching the DB ──────────────────────────
  const ip = extractClientIp(request);
  const rl = checkRateLimit(`api-key:${ip}`, API_KEY_RATE_LIMIT);
  if (!rl.allowed) {
    return { rateLimited: true, result: rl as { allowed: false; retryAfter: number; remaining: number } };
  }

  // ── 2. Extract bearer token ──────────────────────────────────────────────
  const authHeader = request.headers.get("authorization") ?? "";
  const raw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!raw || !isValidApiKeyFormat(raw)) {
    return null;
  }

  // ── 3. Hash and look up ──────────────────────────────────────────────────
  const keyHash = hashApiKey(raw);

  let key: {
    id: string;
    name: string;
    scopes: string[];
    createdById: string;
    maintainerOrgId: string;
    revokedAt: Date | null;
    expiresAt: Date | null;
  } | null;

  try {
    key = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        name: true,
        scopes: true,
        createdById: true,
        maintainerOrgId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
  } catch {
    // DB error: fail closed.
    return null;
  }

  if (!key) {
    return null;
  }

  // ── 4. Lifecycle checks ───────────────────────────────────────────────────
  const now = new Date();

  if (key.revokedAt) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: key.id,
      targetLabel: key.name,
      metadata: { reason: "revoked" },
    });
    return null;
  }

  if (key.expiresAt && key.expiresAt <= now) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: key.id,
      targetLabel: key.name,
      metadata: { reason: "expired" },
    });
    return null;
  }

  // ── 5. Update lastUsedAt (best-effort) ────────────────────────────────────
  try {
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: now },
    });
  } catch {
    // Non-fatal: auth already succeeded.
  }

  // ── 6. Audit successful usage ──────────────────────────────────────────────
  // Log key id, name, and the route path so maintainers can query usage by
  // key name.  The raw token is never forwarded — only the stable metadata
  // fields that the ARCHITECTURE.md redaction policy allows.
  await recordAuditLog({
    action: "api_key.used",
    actorId: key.createdById,
    actorLogin: `api-key:${key.name}`,
    targetId: key.id,
    targetLabel: key.name,
    metadata: {
      route: request.nextUrl?.pathname ?? request.url ?? null,
      keyId: key.id,
      // outcome is always "allowed" here — rejected paths return early above.
      outcome: "allowed",
    },
  });

  return {
    id: key.id,
    name: key.name,
    scopes: key.scopes,
    createdById: key.createdById,
    maintainerOrgId: key.maintainerOrgId,
  };
}

/**
 * Authenticate an API key and enforce a single required scope.
 *
 * Returns the key record on success, `null` on auth failure, a
 * `{ rateLimited: true }` marker when the IP is rate-limited, or a
 * `{ forbidden: true, reason }` marker when the key is missing the scope.
 * Routes map these markers to 429/403 responses so the least-privilege
 * matrix is deterministic and testable.
 */
export async function requireApiKeyScope(
  request: NextRequest,
  required: ApiKeyScope
): Promise<
  | AuthenticatedApiKey
  | { rateLimited: true; result: { allowed: false; retryAfter: number; remaining: number } }
  | { forbidden: true; reason: ApiKeyScopeRejection; required: ApiKeyScope }
  | null
> {
  const auth = await authenticateApiKey(request);

  if (auth === null) {
    return null;
  }

  if ("rateLimited" in auth) {
    return auth;
  }

  const check = enforceApiKeyScope(auth, required);
  if (!check.ok) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: auth.id,
      targetLabel: auth.name,
      metadata: { reason: check.reason, required },
    });
    return { forbidden: true, reason: check.reason, required };
  }

  return auth;
}

/**
 * Build a 403 response for a scope rejection. Routes call this when
 * `requireApiKeyScope` returns a `{ forbidden: true }` marker so the
 * least-privilege matrix surfaces a stable, documented error body.
 */
export function apiKeyScopeForbiddenResponse(
  reason: ApiKeyScopeRejection,
  required: ApiKeyScope
): NextResponse {
  return NextResponse.json(
    { error: "Forbidden", reason, required },
    { status: apiKeyScopeRejectionStatus(reason) }
  );
}

/**
 * Build the standard 403 response emitted by routes that use the simpler
 * `authenticateApiKey` + explicit scope guard pattern (rather than
 * `requireApiKeyScope`).
 *
 * Returns a stable, machine-readable body so clients and tests can assert on
 * the shape without coupling to a human-readable string:
 *
 * ```json
 * { "error": "Forbidden: API key lacks the required scope",
 *   "code": "insufficient_scope",
 *   "requiredScope": "export:read" }
 * ```
 *
 * This function is exported so routes that call `hasScope()` directly can
 * return a consistent error rather than constructing the body themselves.
 */
export function insufficientScopeResponse(required: ApiKeyScope): NextResponse {
  return NextResponse.json(
    {
      error: "Forbidden: API key lacks the required scope",
      code: "insufficient_scope",
      requiredScope: required,
    },
    { status: 403 }
  );
}

/**
 * Build a 429 response for a rate-limited API-key request. Routes call this
 * when `requireApiKeyScope` returns a `{ rateLimited: true }` marker.
 */
export function apiKeyRateLimitedResponse(result: {
  retryAfter: number;
  remaining: number;
}): NextResponse {
  return NextResponse.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: buildRateLimitHeaders(
        { allowed: false, retryAfter: result.retryAfter, remaining: result.remaining },
        API_KEY_RATE_LIMIT.maxRequests
      ),
    }
  );
}
