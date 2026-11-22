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

## Concurrent session limits

Concurrent sessions **are limited per user**. The limit bounds how many active
sessions a single user may hold at once, which caps the persistence window an
attacker gains from a stolen credential.

- **Default limit** — `MAX_CONCURRENT_SESSIONS` (default `5`). Set it via
  environment configuration; see `docs/FEATURE_FLAGS.md` for gating.
- **Enforcement** — When a new session is created and the user already holds
  `MAX_CONCURRENT_SESSIONS` active sessions, the **oldest** session (by
  last-seen time) is revoked before the new one is persisted. The new sign-in
  always succeeds; the evicted session's cookie can no longer be resolved.
- **Idempotency** — Re-authenticating from an existing session refreshes that
  session rather than creating a duplicate, so repeated sign-ins do not consume
  additional slots.
- **Operator visibility** — Evictions are recorded server-side so operators can
  audit unexpected churn. No session identifiers are logged; only the owning
  user and a stable reason code (`session_limit_evicted`).

## Revocation

- **Sign-out** deletes the current session record immediately.
- **Password change** revokes all of the user's sessions except the one used to
  perform the change.
- **Explicit revocation** (operator or self-service) deletes the targeted
  session record; the cookie becomes unresolvable on the next request.
- **Limit eviction** revokes the oldest session as described above.

Revocation is server-side and effective immediately; there is no grace window.

## Org-switch interaction

Switching the active organization does **not** create a new session and does
**not** consume a concurrent-session slot. The active org is stored on the
existing session record and updated in place. Because the session identifier is
unchanged, org-switch preserves the existing CSRF token binding and does not
trigger rotation. Revoking a session revokes it for all orgs the user belongs
to.

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
- **Concurrent session limits** bound takeover persistence from stolen
  credentials.

## Configuration

Session behavior is controlled by environment configuration (idle timeout,
absolute lifetime, cookie flags, and `MAX_CONCURRENT_SESSIONS`). Feature-gated
behavior is documented in `docs/FEATURE_FLAGS.md`.

## Testing

Session flows are exercised by the end-to-end suite. See `docs/E2E_TESTING.md`
for how to run the E2E tests that cover sign-in, session persistence, and
sign-out.

## Related documentation

- [`docs/FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) — feature flag configuration.
- [`docs/CSRF.md`](./CSRF.md) — CSRF protection used with sessions.
- [`docs/E2E_TESTING.md`](./E2E_TESTING.md) — end-to-end test guide.
