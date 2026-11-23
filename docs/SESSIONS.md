# Sessions

This document describes how Trustbridge issues, stores, and validates user
sessions. It is the reference for the session-related surfaces referenced from
the project README.

## Overview

Sessions are used to keep a user authenticated across requests. A session is
created on successful sign-in, persisted server-side, and referenced from the
client via an HTTP-only cookie. Session state is never trusted from the client
beyond the opaque session identifier.

## Lifecycle

1. **Creation** — On successful authentication a new session record is created
   with a random, high-entropy identifier. The identifier is set as an
   HTTP-only, `SameSite=Lax`, `Secure` (in production) cookie.
2. **Validation** — Each authenticated request resolves the cookie to a stored
   session, checks expiry, and attaches the associated user to the request
   context.
3. **Refresh** — Active sessions are extended on use up to a configured maximum
   lifetime. Idle sessions expire after the configured idle timeout.
4. **Revocation** — Sign-out, password changes, and explicit revocation delete
   the server-side session record so the cookie can no longer be resolved.

## Storage

- Session records are stored server-side; the client only ever holds the opaque
  identifier.
- Records include the owning user, creation time, last-seen time, and expiry.
- Expired records are pruned so they cannot be replayed.

## Security properties

- **HTTP-only cookies** prevent JavaScript access to the session identifier.
- **`Secure` cookies** in production prevent transmission over plaintext.
- **`SameSite`** mitigates cross-site request forgery; see `docs/CSRF.md` for
  the CSRF strategy used alongside sessions.
- **Rotation** on privilege change (e.g. sign-in, password change) prevents
  session fixation.
- **Server-side revocation** ensures sign-out is effective immediately.

## Configuration

Session behavior is controlled by environment configuration (idle timeout,
absolute lifetime, cookie flags). Feature-gated behavior is documented in
`docs/FEATURE_FLAGS.md`.

## Testing

Session flows are exercised by the end-to-end suite. See `docs/E2E_TESTING.md`
for how to run the E2E tests that cover sign-in, session persistence, and
sign-out.

## Org membership revocation

When a user is removed from the GitHub maintainer org, the
`POST /api/webhooks/github-org-membership` endpoint immediately revokes
all active `Session` rows for that user via `revokeSessionsForUser()`
(`src/lib/github-org-membership-webhook.ts`).

**How it works:**

1. GitHub delivers a `membership` webhook with `action: "member_removed"`.
2. The webhook handler resolves the user by `githubUsername` (case-insensitive).
3. `prisma.session.deleteMany({ where: { userId } })` deletes all sessions in
   one atomic write — no loop, no TOCTOU window.
4. Any subsequent request that presents a session token for the removed user
   finds no matching row and is treated as unauthenticated.
5. An audit log entry records `sessionsRevoked` count (or `revocationError: true`
   if the deletion failed).

**Important caveats:**

- The dashboard uses **JWT sessions** by default (`strategy: "jwt"` in
  `authOptions`). JWTs are self-contained and cannot be revoked server-side
  until they expire. Session-row deletion only takes effect when the
  `Session` table is populated (i.e. `strategy: "database"` or when the
  NextAuth Prisma adapter is active). Operators who rely on immediate JWT
  invalidation should set a short `maxAge` and pair this with a database
  session strategy.
- Revocation failure is **non-fatal**: a Prisma error returns `sessionsRevoked: -1`
  and sets `revocationError: true` in the audit log but does not cause the
  webhook to return a non-2xx status. GitHub would otherwise retry, potentially
  creating duplicate audit entries.
- The user record and registration data are **not deleted** — the maintainer
  decides whether to remove the account manually.

**Delay expectations:**

| Scenario | Latency |
|---|---|
| Database session strategy | Immediate on next request after webhook delivery |
| JWT session strategy (default) | Up to JWT `maxAge` (default 30 days) |
| JWT + short `maxAge` (e.g. 15 min) | At most 15 minutes |

For Wave incidents requiring immediate access termination, switch to database
sessions or manually invalidate the JWT secret rotation procedure documented
in [SECURITY_POLINRIDER.md](./SECURITY_POLINRIDER.md).

## Related documentation

- [`docs/FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) — feature flag configuration.
- [`docs/CSRF.md`](./CSRF.md) — CSRF protection used with sessions.
- [`docs/E2E_TESTING.md`](./E2E_TESTING.md) — end-to-end test guide.
- [`docs/SECURITY_POLINRIDER.md`](./SECURITY_POLINRIDER.md) — incident response and credential rotation.
