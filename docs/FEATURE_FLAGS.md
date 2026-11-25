# Feature flags

Ɛ Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

`src/lib/feature-flags.ts` is a small flags helper with two sources (env and an
optional database table) plus a built-in default per flag. It exists so shipping-freeze windows, new webhooks, i18n, and other risky changes can be
gated without a deploy — and turned **off** fast during a Wave.

Out of scope: LaunchDarkly / a hosted flag service. An in-app admin UI is
optional; `setFeatureFlag()` and `getAllFeatureFlags()` are provided for one.
An admin-only read-only panel lives at `/dashboard/settings` and lists each
flag's key, resolved value and source.

---

## Resolution order

For every flag, the first source that produces a value wins:

1. **Env override** — `FEATURE_FLAG_<KEY>` (e.g. `FEATURE_FLAG_BATCH_RECHECK=off`).
   Accepted truthy values: `1`, `true`, `on`, `yes`, `enabled`; falsy: `0`,
   `false`, `off`, `no`, `disabled` (case-insensitive). An unrecognised value is
   ignored and resolution falls through.
2. **Database row** — a `FeatureFlag` row, **only** when `FEATURE_FLAGS_DB_ENABLED`
   is truthy. Reads are cached in-process for `FEATURE_FLAGS_CACHE_TTL_MS`
   (default 30s); `clearFeatureFlagCache()` is called automatically after
   `setFeatureFlag()`.
3. **Built-in default** — the `default` in `FEATURE_FLAGS`.

### Fail closed

Flags marked `risky` gate a mutating or destructive path. If the DB source is
**enabled but unreadable** (connection error, table missing, …) a risky flag
resolves to `false` — never to its default. A DB outage therefore *closes*
risky writes rather than leaving them open. Non-risky flags fall back to their
default in the same situation. An env override always wins, even when the DB is
down.

---

## Percentage rollouts (sticky bucketing, issue #661)

A flag can be rolled out to a percentage of users or orgs without flickering
the UI between evaluations. Set `FEATURE_FLAG_<KEY>_ROLLOUT_PERCENT` to an
integer `0`–`100` (unset / invalid = full audience when the flag is on).

### Algorithm

1. Subject key = `${flagKey}:${scope}:${subjectId}` where `scope` is `user` or
   `org` and `subjectId` is a **stable** id (GitHub user/org id — never a
   display name that can change).
2. FNV-1a 32-bit hash of that key → unsigned 32-bit integer.
3. Bucket = `hash % 100` (range `0`–`99`).
4. Subject is in the rollout iff `bucket < rolloutPercent`.

**Boundaries:** `0` → always off; `≥ 100` → always on; non-finite / negative →
fail closed (off). The same `(flag, scope, subjectId)` always lands in the same
bucket, so repeated `isFeatureEnabledForSubject()` calls are **sticky** per
user/org.

Helpers live in `src/lib/feature-flags.ts`: `rolloutBucket()`, `isInRollout()`,
`getRolloutPercent()`, `isFeatureEnabledForSubject()`.

### Flags API auth (issue #661)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/settings/feature-flags` | Session + `isMaintainer` (401 / 403) |
| `POST` | `/api/settings/feature-flags` | Same-origin CSRF **and** maintainer session |

`POST` body: `{ "key": "<flag-key>", "enabled": true|false }`. Unknown keys and
non-boolean `enabled` return `400`. Writes go through `setFeatureFlag()` and
require `FEATURE_FLAGS_DB_ENABLED`; there is **no** unauthenticated toggle path.

---

## Freeze windows

A **freeze window** is a period (typically during a Wave) when risky, mutating
paths are turned off so contributors can't accidentally ship or re-queue work.
Freeze windows are implemented entirely with the flags below — there is no
separate freeze subsystem. To open a freeze, flip the relevant flags off (env
override or DB row); to close it, flip them back on.

| Flag | Freeze effect when off |
|---|---|
| `batch_recheck` | `POST /api/contributors` returns `403` — no per-contributor Horizon fan-out |
| `invite_generation` | `POST /api/invites/generate` returns `403` — invite issuance frozen |
| `dlq_retry` | Contributor and Soroban outbox replay endpoints return `403` — failed items stay parked |
| `maintenance_mode` | Composes with the `MAINTENANCE` env var to take the app read-only |

Because these flags are `risky`, a DB outage during a freeze keeps them **off**
(fail closed) — see [Fail closed](#fail-closed) above. The env vars that drive
freeze windows (`FEATURE_FLAG_*`, `FEATURE_FLAGS_DB_ENABLED`,
`FEATURE_FLAGS_CACHE_TTL_MS`, `MAINTENANCE`) are documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#feature-flags-and-freeze-windows).

### Freeze interactions with the registration UI

Registration is gated by the same flags, so a freeze must be **visible** in the
UI rather than surfacing as a dead end. The registration page
(`src/app/register/`) resolves the freeze state server-side and renders a
read-only notice instead of the form when registration is frozen; the operator
panel at `/dashboard/settings` shows the same state so maintainers can confirm
why sign-ups are closed.

| Flag | Freeze effect when off | Registration UI |
|---|---|---|
| `invite_generation` | `POST /api/invites/generate` returns `403` | `/register` shows the freeze notice; the invite form is hidden and no submit is attempted |
| `maintenance_mode` | App is read-only (composes with `MAINTENANCE`) | `/register` shows the freeze notice; the form is disabled |

When registration is frozen the page renders a stable, actionable message
(`Registration is currently paused during a freeze window. Please try again
later.`) instead of the form, and the API still returns `403` for any direct
`POST` — the UI copy and the API guard stay consistent.

Example — open a registration freeze with an env override:

```bash
FEATURE_FLAG_INVITE_GENERATION=off \
FEATURE_FLAG_MAINTENANCE_MODE=on \
  npm run start
```

Example — open the same freeze with a database row:

```sql
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('invite_generation', false, now())
ON CONFLICT ("key") DO UPDATE SET "enabled" = excluded."enabled", "updatedAt" = now();
```

Because `invite_generation` and `maintenance_mode` are `risky`, a DB outage
during the freeze keeps registration **closed** (fail closed) — the UI notice
stays up and the API keeps returning `403`.

### Freeze-window env vars

The `freeze_window` flag gates the helpers in `src/lib/freeze-window.ts`. When
it is **off**, those helpers never block a request regardless of the
`FREEZE_WINDOW_*` env vars below. When it is **on** (the default), the
`FREEZE_WINDOW_*` vars decide whether a freeze is currently active. These are
the same variables documented in
[ENVIRONMENT.md](./ENVIRONMENT.md#freeze-window-issue-536) — keep both pages in
sync when changing parsing or defaults.

| Env var | Type | Default | Effect |
|---|---|---|---|
| `FREEZE_WINDOW_ENABLED` | boolean | `false` | Master switch. When falsy, no freeze is ever active and the other `FREEZE_WINDOW_*` vars are ignored. |
| `FREEZE_WINDOW_START` | ISO-8601 timestamp | _(unset)_ | Start of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_END` | ISO-8601 timestamp | _(unset)_ | End of the freeze window. Required for a scheduled freeze; an unparseable value is treated as unset. |
| `FREEZE_WINDOW_MESSAGE` | string | _(built-in)_ | Operator-facing message returned with `403` responses while a freeze is active. |

A freeze is active only when `FREEZE_WINDOW_ENABLED` is truthy **and** the
current time falls within `[FREEZE_WINDOW_START, FREEZE_WINDOW_END)`. If either
timestamp is missing or invalid, no scheduled freeze is active (fail open on
misconfiguration, but the `freeze_window` flag still gates the helpers).

Example — schedule a freeze for a Wave:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=on
FREEZE_WINDOW_ENABLED=true
FREEZE_WINDOW_START=2026-03-01T00:00:00Z
FREEZE_WINDOW_END=2026-03-08T00:00:00Z
FREEZE_WINDOW_MESSAGE="Wave 12 freeze in effect — mutating APIs are paused."
```

Example — disable freeze-window blocking entirely:

```dotenv
FEATURE_FLAG_FREEZE_WINDOW=off
```

---

## Readiness / wave-status kill switch (issue #771)

The readiness and wave-status surfaces are gated by the `readiness_ui` flag
(resolved through `src/lib/feature-flags.ts` and consumed by
`src/lib/readiness.ts`). During a Wave incident the readiness UI can be wrong,
slow, or noisy — the kill switch turns it **off** without a deploy so operators
can stop the bleeding while they investigate.

### What the kill switch does

When `readiness_ui` resolves to **off**:

- `src/lib/readiness.ts` short-circuits to a stable `disabled` result — it does
  **not** call the readiness/wave-status data sources, so no partial privileged
  state is produced mid-flight.
- The readiness panel and wave-status badges in the dashboard render a
  read-only "readiness disabled" notice instead of live data.
- Readiness/wave-status API routes return `503` with reason code
  `readiness_disabled` (never a silent success).
- Mutating readiness actions (re-check, wave advance) return `403` with reason
  code `readiness_disabled`.

Existing auth, CSRF, org-scope, pause/freeze, and dry-run semantics are
unchanged — the kill switch only short-circuits the readiness path.

### Flag key and env var

| Surface | Value |
|---|---|
| Flag key | `readiness_ui` |
| Env override | `FEATURE_FLAG_READINESS_UI=off` |
| DB row key | `readiness_ui` (`enabled = false`) |
| Reason code | `readiness_disabled` |

`readiness_ui` is **not** `risky`: it gates a read/display path, so a DB outage
falls back to its default (on) rather than fail-closed. The env override always
wins, even when the DB is down — that is the fastest kill path.

### Procedure — engage the kill switch

1. **Confirm the incident.** Check the readiness panel and
   `GET /api/readiness` (or the wave-status endpoint). If responses are wrong,
   slow, or erroring, proceed.
2. **Flip the flag via env override (fastest, no DB dependency).** Set
   `FEATURE_FLAG_READINESS_UI=off` on the running service and restart/redeploy
   the process. This wins over any DB row.
3. **Or flip via DB row (no restart).** As a maintainer, either use the operator
   panel at `/dashboard/settings` or:

   ```sql
   INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
   VALUES ('readiness_ui', false, now())
   ON CONFLICT ("key") DO UPDATE SET "enabled" = excluded."enabled", "updatedAt" = now();
   ```

   Requires `FEATURE_FLAGS_DB_ENABLED` truthy. The in-process cache clears on
   `setFeatureFlag()`; a raw SQL write is picked up within
   `FEATURE_FLAGS_CACHE_TTL_MS` (default 30s).
4. **Verify it took effect.** The readiness panel shows the "readiness
   disabled" notice; `GET /api/readiness` returns `503` with
   `reason: "readiness_disabled"`; mutating readiness actions return `403` with
the same reason code. `/dashboard/settings` lists `readiness_ui` as `false`
   with source `env` or `db`.
5. **Record the incident.** Note the timestamp, who flipped it, the reason, and
   the reason code in the incident channel.

### Procedure — revert the kill switch

1. **Restore the flag.** Remove `FEATURE_FLAG_READINESS_UI` (or set it to `on`)
   and/or set the DB row back to `enabled = true`:

   ```sql
   UPDATE "FeatureFlag" SET "enabled" = true, "updatedAt" = now()
   WHERE "key" = 'readiness_ui';
   ```

2. **Verify recovery.** The readiness panel renders live data again;
   `GET /api/readiness` returns `200`; mutating readiness actions succeed for
   authorized maintainers. `/dashboard/settings` shows `readiness_ui` as `true`.
3. **Close out.** Confirm no partial privileged state was left behind (the
   short-circuit never started a mutation), and note the revert in the incident
   channel.

### Audit expectations

- **Who can toggle:** only maintainers — via the env override (deploy access)
  or the authenticated `POST /api/settings/feature-flags` (session +
  `isMaintainer` + same-origin CSRF). There is no unauthenticated toggle path.
- **What is logged:** every `POST /api/settings/feature-flags` write is logged
  with the actor, flag key, new value, and timestamp. Readiness short-circuits
  log the `readiness_disabled` reason code so the disabled window is
  reconstructable from logs.
- **Reason codes:** `readiness_disabled` is the stable code for both the `503`
  (read) and `403` (mutate) responses — grep logs and API responses for it to
  bound the incident window.
- **Verification:** the `/dashboard/settings` panel is the source of truth for
  the resolved value and source; cross-check it against the API responses above
  before declaring the incident closed.

### Wave operator risk note

Disabling `readiness_ui` hides readiness/wave-status data — operators lose
visibility into wave progress until it is reverted. Engage it only when the
readiness path itself is the problem, keep the window as short as possible, and
revert as soon as the underlying issue is understood. Because the flag is not
`risky`, a DB outage will **not** keep it off — the env override is the
reliable kill path during a DB incident.

---

## The fl

/* … truncated 4288 chars — edit only what you need near the top … */
