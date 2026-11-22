# Registration data retention and soft-delete lifecycle

This document describes the registration payload TrustBridge stores, how a
registration is soft-deleted, how maintainers find and restore it, and what is
written to the audit log.

## What is actually stored

The registration form (`src/app/register/RegisterClient.tsx`) submits a single
field to `POST /api/register`:

```json
{ "stellarAddress": "G..." }
```

`validateRegistrationInput()` (`src/lib/register-validation.ts`) requires a
trimmed, exactly 56-character Stellar G-address that passes
`StrKey.isValidEd25519PublicKey`. The API also requires an authenticated GitHub
session, a same-origin `Origin` header, and a non-frozen wave window. The
`User` row provides the GitHub identity; the `Registration` row stores the
address plus readiness fields, `maintainerOrgId`, timestamps, and `deletedAt`.

Email addresses, usernames, and invite codes are **not** collected by this
payload, so there is nothing of that kind to retain or purge here. Rejected
payloads are not persisted. Address changes are additionally recorded in the
address-history tables, and operators must not log raw payloads outside the
standard structured/redacted error reporting.

## Soft delete → deleted list → restore

1. **Soft delete** — `DELETE /api/registrations/:id` (maintainer only,
   same-origin) sets `deletedAt` to the current time. The row and its audit
   trail stay in PostgreSQL; readiness queries and the paginated contributor
   list exclude rows with a non-null `deletedAt`. The deletion is recorded as
   audit action `registration.delete` with the address as `targetLabel`.
2. **Deleted list** — `GET /api/registrations/deleted` returns soft-deleted rows
   newest-first with cursor pagination (`limit` default 25, max 100). The lookup
   is scoped to `session.user.maintainerOrgId` when present, so a maintainer
   cannot page through another org's tombstones. Each item exposes `id`,
   `stellarAddress`, `userId`, `githubUsername`, `deletedAt`, `createdAt`, and
   `updatedAt`.
3. **Restore** — `POST /api/registrations/:id/restore` (maintainer only,
   same-origin) finds a row where `id` matches, `deletedAt` is not null, and
   `maintainerOrgId` matches the session's org when one is configured. It then
   clears `deletedAt` in a single `update` and writes audit action
   `registration.restore` with `actorId`, `actorLogin`, `targetId` (registration
   id), `targetLabel` (stellar address), and a `restoredAt` metadata timestamp.
4. **Cache invalidation** — after a successful delete or restore,
   `invalidateContributorListCaches()` busts the shared contributor list caches
   so the dashboard immediately reflects the new membership. Failed mutations
   do not invalidate.

`RestorePanel.tsx` is the maintainer UI for steps 2 and 3. It lists the most
recent deleted registrations (default page size 25, capped at 100) and asks for
confirmation before calling the restore endpoint.

## Delete policy: soft-delete versus hard-delete

Self-delete through `src/app/api/register/delete/route.ts` is a **soft delete**.
The route never issues a `DELETE`/`deleteMany` against the `Registration`
table; it only sets `deletedAt`. Concretely:

- **Soft delete (implemented).** The row, its `stellarAddress`, its
  `maintainerOrgId`, and its audit trail remain in PostgreSQL. Readiness and
  contributor-list queries filter on `deletedAt IS NULL`, so the registration
  disappears from the active surface but is fully **restorable by maintainers**
  via `POST /api/registrations/:id/restore` (see above).
- **Hard delete (not implemented).** There is no route, flag, or env var that
  permanently removes a `Registration` row on self-delete. Permanent removal is
  only reachable through the retention/purge job described below, which is
  dry-run by default and requires an explicit real-purge request. A hard-deleted
  row is **not restorable**; only the audit trail survives.

Because self-delete is soft, a GDPR erasure request that requires permanent
removal must go through the retention purge path (with a dry-run report
archived first), not through the self-delete route. This distinction is what
keeps Wave operators from assuming a self-delete already purged the record.

### Policy tests

The delete route's semantics are pinned by automated tests
(`src/app/api/register/delete/route.test.ts`). They assert:

- **Happy path** — an authorized, same-origin, in-scope self-delete returns
  success, sets `deletedAt` (soft delete), writes a `registration.delete` audit
  entry, and leaves the row restorable.
- **Failure: unauthenticated / missing session** — returns `403` with no
  `update`, no audit entry, and no cache invalidation.
- **Failure: cross-origin request** — `assertSameOrigin` rejects with `403`
  before any DB work.
- **Failure: out-of-scope or already-deleted target** — returns `404` with no
  mutation, matching the tombstone-enumeration guard used by restore.

If the route ever drifts to a hard delete, these tests fail, forcing a matching
update to this document and to the audit reason codes below.

## Authorization and response semantics

| Situation | Status | Notes |
|---|---|---|
| Missing/invalid maintainer session | `403` `{ "error": "Forbidden" }` | No `findFirst`, `update`, audit entry, or cache invalidation |
| Cross-origin request | `403` | `assertSameOrigin` runs before session lookup and any DB work |
| Registration id missing, already active, or in another org | `404` `{ "error": "Deleted registration not found" }` | Identical response for all three cases prevents tombstone enumeration |
| Another active registration already uses the address | `409` `{ "error": "This Stellar address is already actively registered" }` | Prisma unique-constraint (`P2002`) from the `stellarAddress` index; no audit entry |
| Success | `200` `{ "success": true, "registration": ... }` | Audited and cache-invalidated |

The deleted list follows the same `403` rule for non-maintainers. Org scoping
uses the same `maintainerOrgId` value in both routes; sessions created before
that field existed fall back to `"default"`, which keeps single-tenant
deployments working.

## Retention job dry-run reports

The retention/deletion cron supports a **dry-run** mode that reports what would
be purged without deleting anything. Dry-run is the default; a real purge must
be explicitly requested. Dry-run reports are produced in two formats, JSON and
CSV, and both apply the existing redaction policy (see below) so no secrets,
tokens, or unmasked sensitive addresses leak.

### JSON report shape

```jsonc
{
  "generatedAt": "2024-01-01T00:00:00.000Z", // ISO-8601 timestamp
  "dryRun": true,                            // always true for dry-run reports
  "cutoff": "2023-01-01T00:00:00.000Z",      // records older than this are candidates
  "total": 2,                                // number of candidate records
  "records": [
    {
      "id": "reg_123",                       // opaque record id
      "createdAt": "2022-06-01T00:00:00.000Z",
      "email": "j***@example.com",           // redacted per policy
      "username": "j***e",                    // redacted per policy
      "walletAddress": "0x12…ab"             // redacted per policy
    }
  ]
}
```

### CSV report shape

CSV reports use a fixed header row and one row per candidate record. Fields are
quoted per RFC 4180 and values are redacted identically to the JSON report:

```csv
id,createdAt,email,username,walletAddress
reg_123,2022-06-01T00:00:00.000Z,j***@example.com,j***e,0x12…ab
```

### Redaction policy

- `email`: local part reduced to its first character plus `***`, domain kept.
- `username`: first and last character kept, middle replaced with `***`.
- `walletAddress`: first and last two characters kept, middle replaced with `…`.
- Any field not listed above is omitted from reports rather than emitted raw.

### Reason codes

Dry-run report generation fails with stable, documented reason codes:

| Reason code            | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `invalid_format`       | Requested report format is not `json` or `csv`.                |
| `invalid_cutoff`       | Cutoff timestamp is missing or malformed.                      |
| `payload_too_large`    | Candidate set exceeds the configured report size limit.        |
| `permission_denied`    | Caller lacks the operator scope required for retention jobs.   |
| `dependency_failure`   | Underlying data store or dependency failed; nothing was purged.|

Failures never report silent success: a non-`ok` result always carries one of
the reason codes above. Dry-run never deletes records, so repeated or
concurrent invocations are idempotent and leave no partial privileged state.

## Operator notes

- `AuditAction` in `src/types/index.ts` includes `registration.delete` and
  `registration.restore`; query `/api/audit` for either action to reconstruct a
  tombstone's lifecycle. Self-delete writes `registration.delete` (soft); a
  retention purge is the only path that permanently removes a row.
- The OpenAPI document (`src/lib/openapi-spec.ts`) describes the restore `409`
  as the address-conflict case, not as "registration is not deleted" (which is
  a `404`).
- Restore is a write: it is blocked by maintenance mode and by an active wave
  freeze window if those guards are enabled for the deployment.

- Validation rules live in the shared schemas under `src/lib/`; update them in
  one place to keep the API and client consistent.
- If a new registration field is added, extend the shared schema and update the
  table above so retention expectations remain documented.
- Always rehearse a purge with a dry-run report (JSON or CSV) before running a
  real deletion, and archive the report for audit purposes.
