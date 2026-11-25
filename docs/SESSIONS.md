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

## Rotation

Session identifiers are rotated on every privilege change so that an identifier
an attacker may have pre-set (fixated) before authentication cannot be reused
after the privilege change.

- **On login** — A successful sign-in always issues a fresh session identifier.
  Any pre-authentication session referenced by the incoming cookie is
  invalidated (deleted server-side) before the new identifier is issued. The
  new cookie is set on the same response that completes the login.
- **On org-switch** — Switching the active organization rotates the session
  identifier as well, invalidating the previous identifier. The new session
  carries the same user but the newly selected organization scope.

Rotation is atomic with respect to the privilege change: if the new session
cannot be persisted, the login/org-switch fails and the previous session is
left invalidated rather than silently continuing with a stale identifier.

### Reason codes

Rotation failures surface stable reason codes so callers and operators can
react consistently:

- `session_rotation_failed` — the new session record could not be persisted.
  The request fails; no privileged state is established.
- `session_invalid` — the incoming session identifier is missing, malformed, or
  no longer resolvable (e.g. already rotated or revoked).
- `org_membership_required` — an org-switch was requested for an organization
  the user is not a member of. The session is not rotated.

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
- **Rotation** on privilege change (sign-in, org-switch, password change)
  prevents session fixation by invalidating the pre-rotation identifier.
- **Server-side revocation** ensures sign-out is effective immediately.

## Configuration

Session behavior is controlled by environment configuration (idle timeout,
absolute lifetime, cookie flags). Feature-gated behavior is documented in
`docs/FEATURE_FLAGS.md`.

## Testing

Session flows are exercised by the end-to-end suite. See `docs/E2E_TESTING.md`
for how to run the E2E tests that cover sign-in, session persistence, and
sign-out. Rotation is additionally covered by unit tests for the login and
org-switch paths, including the happy path (old identifier rejected after
rotation) and failure paths (invalid pre-auth session, rotation persistence
failure, org-switch without valid membership).

## Related documentation

- [`docs/FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) — feature flag configuration.
- [`docs/CSRF.md`](./CSRF.md) — CSRF protection used with sessions.
- [`docs/E2E_TESTING.md`](./E2E_TESTING.md) — end-to-end test guide.
