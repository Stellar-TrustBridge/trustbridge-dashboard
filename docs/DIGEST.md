# Digest

The digest is the periodic email summary of notification activity sent to users of the TrustBridge dashboard.

## Delivery

- Digests are assembled and sent by `src/lib/email.ts`.
- The API surface for reading and updating notification preferences lives in `src/app/api/notifications/route.ts`.
- All routes preserve the existing auth, CSRF, and org-scope rules enforced by `src/lib/auth.ts`.

## Default preferences for new users

When a user has no stored notification preferences, the notifications module seeds safe defaults so that new accounts are not flooded with mail:

| Preference | Default | Notes |
| --- | --- | --- |
| `digest` | `weekly` | One summary per week instead of per-event mail. |
| `disputes` | `on` | Dispute notifications stay enabled because they are actionable. |

These defaults are applied only when a preference is absent. Explicitly stored values (including `digest: "off"` or `disputes: false`) are always respected and are never overwritten by the seeding logic.

### Behavior

- Reading preferences for a user with no stored record returns the seeded defaults above.
- Updating a single preference merges with the seeded defaults, so unspecified keys fall back to the defaults rather than to `undefined`.
- Seeding is idempotent: repeated reads or updates do not create duplicate records or change already-stored values.

## Failure modes

- Malformed preference payloads are rejected with a stable validation error; no partial preference state is written.
- Unauthorized or out-of-scope requests are rejected by the existing auth/org-scope checks before any preference is read or written.
- Email delivery failures surface as actionable errors from `src/lib/email.ts` and never report silent success.

## Testing

Targeted tests cover the happy path (defaults seeded for a new user) and failure paths (malformed payload rejected, unauthorized request rejected). Run the notifications test target for the touched paths before opening a PR.
