# Maintainer Workflow

This guide documents operational workflows for TrustBridge maintainers and treasurers, including the `trustbridge-dash` CLI, wave freeze windows, and payout verification.

---

## 1. CLI (`trustbridge-dash`)

The `trustbridge-dash` CLI allows maintainers and automated scripts to export payout data and initiate address rechecks without relying on browser UI sessions.

### Installation & Local Usage

The CLI is registered in `package.json` under `"bin"`:

```bash
# Direct execution via npm/npx or node
./scripts/cli/index.mjs --help
npx trustbridge-dash --help
```

### Commands

#### 1. Login / Credential Setup
Save the target URL and API key locally (stored in `~/.trustbridge/config.json` with `0600` permissions):
```bash
trustbridge-dash login --url https://dashboard.trustbridge.org --api-key <YOUR_API_KEY>
```

Alternatively, provide configuration via environment variables:
```bash
export TRUSTBRIDGE_API_URL="https://dashboard.trustbridge.org"
export TRUSTBRIDGE_API_KEY="<YOUR_API_KEY>"
```

#### 2. Treasury Export
Export contributor readiness and Stellar addresses in CSV (default) or JSON format:
```bash
# Export CSV to stdout or file
trustbridge-dash export --format csv --out ./treasury-export.csv

# Export JSON
trustbridge-dash export --format json --out ./treasury-export.json
```

API clients can request the same formats by POSTing `{"format":"csv"}` or
`{"format":"json"}` to `/api/treasury/export`. The endpoint requires an
operator session or an API key with the `export:read` scope and applies its
same-origin request check.

#### 3. Recheck
Trigger an address verification / readiness check:
```bash
# Batch recheck all contributors (asynchronous background queue)
trustbridge-dash recheck --all

# Recheck a single contributor
trustbridge-dash recheck --username octocat
```

### Batch recheck progress stream

`POST /api/contributors` enqueues a `recheck.batch` job; monitor it with
`GET /api/contributors/queue/progress?jobId=<id>` (maintainer session required,
`text/event-stream`). Events arrive in this order:

1. `status` — initial snapshot (`jobId`, `status`, `createdAt`, `startedAt`).
2. `progress` — zero or more snapshots while the job is processing.
3. `processing` — heartbeat on each poll while still running.
4. `completed` or `failed` — terminal event (or `error` for a missing/foreign job).

Jobs with no persisted progress produce only `status` → `processing` → terminal
events, so existing consumers are unaffected. Snapshots are deduplicated by
`updatedAt`; only strictly newer timestamps are emitted.

The stable progress payload is:

```json
{
  "type": "progress",
  "jobId": "job-42",
  "processed": 12,
  "total": 40,
  "errors": 1,
  "done": false,
  "updatedAt": "2026-10-01T00:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `type` | Always `"progress"` |
| `jobId` | Id of the background queue job |
| `processed` | Number of contributor checks completed so far |
| `total` | Total contributor checks in the batch |
| `errors` | Number of checks that failed (counted from results) |
| `done` | `true` once every check has been recorded |
| `updatedAt` | Monotonic ISO-8601 timestamp, used for dedupe/reconnect |

The worker persists each snapshot in the queue job's existing `result` column
under `result.progress` while the job is `processing`. The final `result`
overwrites that field entirely, so the completed-job result shape is unchanged.
`useJobProgress()` (`src/lib/use-job-progress.ts`) exposes the event fields to
the dashboard without closing the stream on `progress`.

### Security & Protocol Constraints
- **HTTPS Enforcement**: Unencrypted HTTP (`http://`) endpoints are strictly rejected by the CLI to protect API keys and contributor information.
- **Log Masking**: API keys and tokens are never printed in full to logs or error outputs.

---

## 2. Wave Roster Freeze Window

To prevent roster changes or rechecks from shuffling readiness states immediately prior to wave payout settlement:

- **Configuration**:
  - `FREEZE_WINDOW_START` (ISO 8601, e.g. `2026-08-30T00:00:00Z`).
  - `FREEZE_WINDOW_END` (ISO 8601, e.g. `2026-09-02T00:00:00Z`).
  - `FREEZE_WINDOW_ENABLED=true` (or `false` to disable).
- **Behavior**:
  - Mutating operations (`POST /api/register/recheck`, address updates in `POST /api/register`) are blocked during an active freeze window with HTTP `423 Locked` (`code: WAVE_FREEZE_ACTIVE`).
  - Read operations (`GET /api/register`, dashboard viewing) remain fully operational.
  - Blocked attempts are logged in the audit log as `recheck.freeze_blocked` / `address_change.freeze_blocked`.
- **Maintainer Override**:
  - Maintainers can bypass an active freeze window when necessary by supplying header `x-freeze-override: true` or query param `overrideFreeze=true`.
  - Override operations are recorded in the audit log as `recheck.freeze_override` / `address_change.freeze_override`.

---

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

## 3. Horizon Latency Metrics

- The maintainer metrics dashboard aggregates `horizonLatencyMs` from Horizon address checks.
- Visualizes average latency, median (p50), p95 latency, and sample counts.
- Displays an empty state banner when no samples exist.

---

## 4. Contributor Ban & Unban Management

- Maintainers can ban an abusive or compromised contributor via the maintainer dashboard or `POST /api/maintainer/ban` (`action: "ban"`, `githubUsername: "<username>"`, `reason: "<mandatory reason>"`).
- Banning requires a non-empty reason and applies case-insensitively across current and future account re-registrations.
- Unban via `POST /api/maintainer/ban` (`action: "unban"`, `githubUsername: "<username>"`).
- All actions record audit trail events (`contributor.banned`, `contributor.unbanned`).

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

## 4a. Duplicate Wallet Claim Conflicts

When a contributor submits a Stellar address that another user already holds,
`POST /api/register` returns `409` with:

```json
{
  "error": "That Stellar address is already registered to another contributor. Use a different wallet address, or contact a maintainer if you believe it is yours — the conflict has been logged for maintainer review.",
  "code": "ADDRESS_TAKEN"
}
```

The same body is returned by `POST /api/registrations/:id/restore` when the
restored address has since been claimed. The copy lives in
`src/lib/registration-errors.ts` so both routes stay in sync; update it there
rather than duplicating strings in the UI.
