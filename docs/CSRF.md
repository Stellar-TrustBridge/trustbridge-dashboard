# CSRF Protection

TrustBridge Dashboard uses **origin validation** (`assertSameOrigin`) for mutating API routes and **double-submit CSRF tokens** (`validateCsrfToken`) for sensitive read endpoints. This page documents the complete inventory of routes, methods, CSRF enforcement, and header names for client wiring.

← Back to [README](../README.md)

---

## Cookie attribute matrix

CSRF and session cookies must be emitted with attributes that match the deployment environment. `src/lib/csrf.ts` exposes `resolveCsrfCookieAttributes()` which returns the attribute matrix below and **fails closed** with a stable reason code when production would emit an insecure cookie.

| Attribute | local / dev / test | production |
|-----------|--------------------|------------|
| `SameSite` | `Lax` | `Strict` |
| `Secure` | `false` (plain HTTP localhost) | `true` (required) |
| `HttpOnly` | `true` | `true` |
| `Path` | `/` | `/` |
| `Max-Age` | `86400` (24h) | `86400` (24h) |

### Fail-closed reason codes

`resolveCsrfCookieAttributes()` throws a `CsrfCookieConfigError` (with a stable `code`) instead of returning an insecure cookie in production:

| Reason code | Trigger |
|-------------|---------|
| `CSRF_COOKIE_INSECURE_SAMESITE_NONE` | `SameSite=None` requested without `Secure` |
| `CSRF_COOKIE_INSECURE_MISSING_SECURE` | Production would emit a cookie with `Secure=false` |
| `CSRF_COOKIE_INSECURE_SAMESITE` | Production would emit `SameSite=None` (cross-site) |
| `CSRF_COOKIE_INVALID_MAX_AGE` | `Max-Age` is not a positive integer |

Operators see these codes surfaced through `src/lib/auth.ts` (`describeCsrfCookieConfigError`) so a misconfigured deployment fails loudly at startup rather than silently weakening Wave CSRF defenses. See [DEPLOYMENT — CSRF cookie attributes](./DEPLOYMENT.md#csrf-cookie-attributes) for the operator runbook.

---

## Threat model

Without CSRF protection, a malicious page could trick an authenticated user into performing unwanted actions:

- An attacker submits a hidden `<form>` to `POST /api/register`, overwriting the contributor's payout address to an attacker-controlled G-address
- An attacker triggers `POST /api/contributors` (batch re-check), exhausting Horizon API quota at 100+ contributor scale
- An attacker triggers `POST /api/treasury/export`, exfiltrating contributor payout data
- An attacker triggers `POST /api/register/delete`, wiping a user's registration
- An attacker triggers `POST /api/contract-sync`, forcing a re-sync of Horizon data into Postgres
- An attacker triggers `POST /api/maintainer/ban` or `POST /api/registrations/[id]/restore`, banning or restoring contributors using a Wave maintainer's browser session
- An attacker triggers `POST /api/settings/feature-flags` or `POST /api/settings/network`, altering payout settings or toggling privileged features

Because the application uses **cookie-based session authentication** (NextAuth JWT cookie), these requests would otherwise inherit the victim's session automatically.

---

## Mutating routes (CSRF same-origin-validated)

Every mutating route handler under `src/app/api/` calls `assertSameOrigin` from `src/lib/csrf.ts` before any downstream logic. The table below lists all mutating (non-safe) API routes, their CSRF enforcement, and the header each client must wire.

| Route | Method | CSRF Protected | Header | Auth Level | Notes |
|-------|--------|----------------|--------|------------|-------|
| `/api/check` | POST, OPTIONS | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Public | Non-browser clients skip Origin/Referer check |
| `/api/register` | POST, GET | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Authenticated | GET is read-only |
| `/api/address-history` | GET | Yes (`validateCsrfToken`) | `x-csrf-token` | Authenticated | Double-submit token required for GET |
| `/api/contributors` | GET, POST | POST only | — (Origin/Referer only) | Maintainer | GET read-only |
| `/api/contributors/paginated` | GET | No (read-only) | — | Maintainer | — |
| `/api/contributors/[id]` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | — |
| `/api/contributors/[id]/notes` | PATCH | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | — |
| `/api/contributors/queue/status` | GET | No (read-only) | — | Maintainer | — |
| `/api/contributors/queue/jobs/[jobId]` | GET | No (read-only) | — | Maintainer | — |
| `/api/contributors/queue/progress` | GET | No (Server-Sent Events) | — | Maintainer | — |
| `/api/audit` | GET | No (read-only) | — | Maintainer | — |
| `/api/stats` | GET | No (read-only) | — | Publicly cached | — |
| `/api/contract-sync` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer or scheduler | GET read-only |
| `/api/cron/export` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer or scheduler | GET read-only |
| `/api/disputes` | GET, POST, PATCH | POST/PATCH only (`assertSameOrigin`) | — (Origin/Referer only) | Authenticated + Maintainer | GET read-only |
| `/api/soroban/events` | GET | No (read-only) | — | Maintainer | — |
| `/api/settings/network` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | GET read-only |
| `/api/settings/feature-flags` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | GET read-only |
| `/api/settings/api-keys` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Operator | GET read-only |
| `/api/settings/api-keys/[id]` | DELETE | DELETE only (`assertSameOrigin`) | — (Origin/Referer only) | Operator | — |
| `/api/notifications/email-nudge` | GET, POST | GET and POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | GET read-only |
| `/api/treasury/export` | GET, POST | POST only (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | GET optional read; POST requires same-origin |
| `/api/graphql` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | — |
| `/api/metrics` | GET | No (read-only) | — | Operator | — |
| `/api/metrics/prometheus` | GET | No (read-only) | — | Maintainer or allowlisted | — |
| `/api/maintainer/ban` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | — |
| `/api/maintainer/conflicts` | GET | No (read-only) | — | Maintainer | — |
| `/api/register/checklist` | PATCH | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Authenticated | Self-service checklist updates |
| `/api/register/export` | GET | No (read-only) | — | Authenticated | Self-service data export |
| `/api/register/recheck` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Authenticated | Self-service recheck |
| `/api/register/delete` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Authenticated | Self-service deletion |
| `/api/invites/generate` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | (implementation-dependent) | — |
| `/api/registrations/[id]` | DELETE | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | Soft-delete registration |
| `/api/registrations/[id]/restore` | POST | Yes (`assertSameOrigin`) | — (Origin/Referer only) | Maintainer | Restore soft-deleted registration |
| `/api/registrations/deleted` | GET | No (read-only) | — | Maintainer | — |
| `/api/auth/session-info` | GET | No (read-only) | — | Authenticated | Session JWT facts |

### Sensitive read routes (double-submit CSRF token required)

These GET endpoints expose personally-identifiable payout timeline data and require a valid CSRF token in addition to session authentication.

| Route | Method | CSRF Protected | Header / Param | Auth Level |
|-------|--------|----------------|----------------|------------|
| `/api/address-history` | GET | Yes (`validateCsrfToken`) | `x-csrf-token` header or `csrfToken` query param | Authenticated |

**Why this route needs a CSRF token:** `GET /api/address-history` reveals a contributor's payout address history. Although GET is a "safe" method by HTTP semantics, the response contains PII that should not be disclosed to cross-site requests. The double-submit token pattern (Header `x-csrf-token` + Cookie `csrf_token`) enforces this. The cookie is set via NextAuth's session mechanism (or a dedicated CSRF middleware), and the client must read the cookie and echo it back as a header on every request.

The CSRF check runs before any target-user, pagination, or projection logic. It
applies to every page: `AddressHistoryPanel` echoes the token on the initial
request and on each `?cursor=` request from `useInfiniteQuery`. Maintainers can
add `?userId=<id>` only after the same token check; maintainer responses are
field-projected, non-cacheable, and audited without address values. See
[Architecture — Address history pagination and privacy](./ARCHITECTURE.md#address-history-pagination-and-privacy).

---

## Maintainer mutation routes (double-submit cookie contract)

The following maintainer mutation routes are covered by the double-submit cookie integration tests in `src/lib/__tests__/csrf.test.ts`. Each route must reject requests that are missing the `csrf_token` cookie, missing the `x-csrf-token` header, or present a mismatched pair. The tests assert the happy path (matching cookie + header) and at least two distinct failure paths (missing token, mismatched token) for every route below.

| Route | Method | Happy path | Missing token | Mismatched token |
|-------|--------|------------|---------