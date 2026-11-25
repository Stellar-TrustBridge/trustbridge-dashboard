# Maintainer Workflow

This document describes how maintainers operate the TrustBridge dashboard, including the audit export pipeline used for Wave compliance reporting.

## Audit export

Audit exports are served by `src/app/api/audit/route.ts`, which delegates to `src/lib/audit.ts`. Formatting of exported rows is centralized in `src/lib/audit-format.ts`.

### Pagination for large orgs

Large organizations can accumulate audit histories that exceed a single response budget. The export endpoint paginates so that a single request never has to materialize the full history:

- Requests accept `limit` (page size) and `cursor` (opaque continuation token) query parameters.
- Responses return a `nextCursor` value when more rows remain; omit it on the final page.
- Page size is clamped to a documented maximum; oversized `limit` values are rejected with a stable error rather than silently truncated.
- Malformed `cursor` values fail with a stable, documented error code instead of returning partial data.

Operators exporting very large orgs should follow the cursor until `nextCursor` is absent rather than requesting an unbounded export.

### Operator chunking guidance

When running compliance exports for large orgs:

1. Start with a modest `limit` (for example, the default page size) and follow `nextCursor` until exhausted.
2. Persist each page before requesting the next so a mid-flight abort leaves no partial privileged state.
3. Treat any non-2xx response as a hard failure — do not assume an empty page means completion.
4. Respect existing auth, CSRF, org-scope, pause/freeze, and dry-run semantics; pagination does not bypass any of them.

### Stress tests

Pagination behavior for large orgs is covered by automated tests that exercise the happy path (multi-page traversal) plus failure paths (oversized/malformed pagination input and permission/network failure). Run the targeted checks for touched paths before merging:

```
# targeted audit tests
npm test -- audit

# repo gates for touched paths
npm run lint
npm run typecheck
```

Include the commands run and a short risk note for Wave operators in the PR description.

## 2a. Maintenance Banners (Planned Downtime Windows)

Maintainers can schedule dashboard maintenance banners so wave contributors get
notice before a freeze or deploy. Windows are stored and served by
`src/lib/maintenance.ts` and exposed through `/api/maintenance`.

### Public read

`GET /api/maintenance` requires **no authentication** and returns the windows
that are currently active or upcoming (past windows are omitted):

```json
{
  "windows": [
    {
      "id": "mw-1",
      "message": "Dashboard read-only during wave payout",
      "startsAt": "2026-10-01T00:00:00.000Z",
      "endsAt": "2026-10-01T02:00:00.000Z",
      "severity": "warning",
      "status": "active"
    }
  ]
}
```

`status` is one of `upcoming`, `active`, or `ended` (ended windows are filtered
out of the public response). `severity` is `info`, `warning`, or `critical`.

### Maintainer write

`POST /api/maintenance` (create), `PATCH /api/maintenance` (update), and
`DELETE /api/maintenance?id=<id>` (cancel) require a maintainer session and the
same-origin CSRF check used by other mutating routes. Unauthorized callers get
HTTP `401`/`403` with an actionable `error`/`code` body — never a silent
success.

```bash
curl -X POST https://dashboard.trustbridge.org/api/maintenance \
  -H 'content-type: application/json' \
  -H 'x-csrf-token: <token>' \
  --data '{"message":"Read-only during payout","startsAt":"2026-10-01T00:00:00Z","endsAt":"2026-10-01T02:00:00Z","severity":"warning"}'
```

### Validation & reason codes

Malformed or oversized input fails with a stable `code`:

| Outcome | HTTP | `code` |
|---|---|---|
| Missing/empty message | 400 | `MAINTENANCE_MESSAGE_REQUIRED` |
| Message over 280 chars | 400 | `MAINTENANCE_MESSAGE_TOO_LONG` |
| Non-ISO-8601 timestamp | 400 | `MAINTENANCE_INVALID_TIMESTAMP` |
| `endsAt` not after `startsAt` | 400 | `MAINTENANCE_INVALID_WINDOW` |
| Unknown severity | 400 | `MAINTENANCE_INVALID_SEVERITY` |
| Unknown window id | 404 | `MAINTENANCE_NOT_FOUND` |
| Non-maintainer write | 403 | `MAINTENANCE_FORBIDDEN` |

Writes are idempotent per window id: re-submitting the same payload for an
existing id is a no-op update, and cancelling an already-cancelled window
returns success without partial state.

---
