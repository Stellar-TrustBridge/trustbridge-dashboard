# Architecture

TrustBridge Dashboard is a Next.js (App Router) application that surfaces
contributor, payout, and audit data for Wave operators. This document describes
the high-level structure and the cross-cutting rules that every module must
follow.

## Layers

- **UI (`src/app`, `src/components`)** — server components fetch data through
  the API routes; client components handle interaction and optimistic updates.
- **API routes (`src/app/api/**`)** — thin handlers that validate input, enforce
  auth/CSRF/org-scope, and delegate to library code.
- **Libraries (`src/lib/**`)** — pure, testable logic (pagination, redaction,
  policy evaluation, etc.).
- **Docs (`docs/**`)** — operator- and client-facing contracts.

## Cross-cutting rules

- **Auth & CSRF** — every mutating route validates the session and CSRF token
  before touching state. Org scope is derived from the session, never from the
  request body.
- **Pause / freeze / dry-run** — privileged operations honor the current
  pause/freeze state and support dry-run previews. A dry-run must never mutate
  state.
- **Redaction** — sensitive addresses and tokens are masked per the existing
  redaction policy before they leave the server.
- **Idempotency** — repeated or concurrent invocations of the same operation
  must be safe where the API promises idempotency.

## Pagination

List endpoints use cursor-based pagination implemented in
`src/lib/cursor-pagination.ts` and consumed by routes such as
`src/app/api/contributors/paginated/route.ts`.

- Cursors are **opaque, signed, and time-limited**. A cursor carries the
  position of the last item plus an expiry timestamp.
- When a cursor is expired, malformed, or fails signature verification, the API
  responds with a stable `InvalidCursor` error shape (see
  `docs/LOGGING_AND_PAGINATION.md`).
- Clients must treat `InvalidCursor` as a terminal signal for the current
  traversal: restart from the first page (no cursor) rather than retrying the
  same cursor. Retrying an expired cursor in a loop is a bug.

See `docs/LOGGING_AND_PAGINATION.md` for the full cursor TTL, error shape, and
client retry/backoff guidance.

## Logging

Structured logs are emitted for every API request and privileged operation.
Log fields, redaction rules, and pagination logging are documented in
`docs/LOGGING_AND_PAGINATION.md`.

## Testing

- Unit tests live next to the modules they cover (`*.test.ts`).
- API routes are covered by integration tests that exercise the happy path and
  at least two failure paths (auth failure, invalid input, expired cursor).
- Run targeted checks with the repo's existing test/fmt/lint targets for the
  touched paths.
