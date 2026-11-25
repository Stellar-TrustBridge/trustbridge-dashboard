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

## Ban → conflict → restore smoke path

The end-to-end smoke outline for exercising ban, the duplicate-wallet conflict,
and restore with test users (including CSRF and auth setup) lives in
[`docs/E2E_TESTING.md`](./E2E_TESTING.md#maintainer-ban--conflict--restore-smoke-path).
Keep that outline in sync with the ban route reason codes and inputs whenever the
ban route changes.

### Bulk ban dry-run report (issue #780)

Bulk bans support a **dry-run** mode that reports what *would* happen without
mutating any ban state. Pass `dryRun: true` alongside a bulk ban request:

```json
{
  "action": "ban",
  "githubUsernames": ["octocat", "hubot"],
  "reason": "Coordinated spam wave",
  "dryRun": true
}
```

The response is a stable report shape (no `User.banned*` flags or
`BannedContributor` rows are written, and no `contributor.banned` audit events
are emitted):

```json
{
  "dryRun": true,
  "report": {
    "total": 3,
    "wouldBan": 1,
    "alreadyBanned": 1,
    "skipped": 1,
    "entries": [
      { "githubUsername": "octocat", "outcome": "would_ban" },
      { "githubUsername": "hubot", "outcome": "already_banned" },
      { "githubUsername": "", "outcome": "skipped", "reason": "INVALID_USERNAME" }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `total` | Number of requested handles (after dedupe) |
| `wouldBan` | Handles that would be newly banned |
| `alreadyBanned` | Handles already banned (idempotent no-op) |
| `skipped` | Handles skipped due to validation/self-moderation |
| `entries[].outcome` | `would_ban` \| `already_banned` \| `skipped` |
| `entries[].reason` | Present on `skipped` entries (e.g. `INVALID_USERNAME`, `SELF_BAN_FORBIDDEN`) |

Dry-run requests still require the same maintainer auth, CSRF, and org-scope
checks as a real bulk ban, and are blocked by an active freeze window unless
the maintainer override is supplied. A dry-run never records audit events; the
real bulk ban continues to emit `contributor.banned` per affected handle.

### Race safety and self-moderation (issue #660)

Ban and unban write **two** surfaces (`User.banned*` flags and the persistent
`BannedContributor` row). Both operations now run inside a single
`prisma.$transaction` so a concurrent ban/unban cannot observe a half-applied
state — the user flag and the ban row commit together or not at all. Audit
events are written only **after** the transaction commits; a failed transaction
leaves no audit trail and no partial ban.

**Self-moderation is rejected.** An actor may not ban or unban their own
handle (case-insensitive on `githubUsername`, or when `actorId` matches the
resolved user id). The API returns:

```json
{
  "error": "Maintainers cannot unban their own account.",
  "code": "SELF_UNBAN_FORBIDDEN"
}
```

with HTTP **403**. Ban uses `code: "SELF_BAN_FORBIDDEN"` with the same status.
Use a second maintainer (or an org admin) to lift a ban on a moderator account.

| Outcome | HTTP | `code` |
|---|---|---|
| Self-unban attempt | 403 | `SELF_UNBAN_FORBIDDEN` |
| Self-ban attempt | 403 | `SELF_BAN_FORBIDDEN` |
| Empty ban reason | 400 | `REASON_REQUIRED` (service) / plain `error` from the route |
| Success | 200 | — (audit: `contributor.banned` / `contributor.unbanned`) |

Appeal notes (`addBanAppealNote`) continue to write
`contributor.ban_appeal_note` audit entries; they never mutate ban state on
their own — unban remains an explicit maintainer action subject to the rules
above.

**Maintainer UX:** the ban modal should disable the “unban” control when the
selected handle matches the signed-in maintainer, and surface the API’s
`code`/`error` body when the request is rejected so operators know to ask a
peer to act instead of retrying.

---
