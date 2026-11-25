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
