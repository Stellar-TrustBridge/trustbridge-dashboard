# Feature flags

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

`src/lib/feature-flags.ts` is a small flags helper with two sources (env and an
optional database table) plus a built-in default per flag. It exists so
shipping-freeze windows, new webhooks, i18n, and other risky changes can be
gated without a deploy — and turned **off** fast during a Wave.

Out of scope: LaunchDarkly / a hosted flag service. An in-app admin UI is
optional; `setFeatureFlag()` and `getAllFeatureFlags()` are provided for one.

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

## The flags

| Key | Default | Risky | Gates | Documented at |
|---|---|---|---|---|
| `batch_recheck` | `true` | ✅ | `POST /api/contributors` — full batch recheck (one Horizon call per contributor) | `src/app/api/contributors/route.ts` |
| `invite_generation` | `true` | ✅ | `POST /api/invites/generate` — bulk invite code creation | `src/app/api/invites/generate/route.ts` |
| `dlq_retry` | `true` | ✅ | `POST /api/contributors/queue/dlq/[jobId]/retry` — re-queue a failed job | `src/app/api/contributors/queue/dlq/[jobId]/retry/route.ts` |
| `maintenance_mode` | `false` | ✅ | Composes with the `MAINTENANCE` env var (see [DEPLOYMENT.md](./DEPLOYMENT.md#maintenance-mode)) | `src/lib/maintenance.ts` |
| `otel_traces` | `false` | — | Opt-in tracing; composes with `OTEL_TRACES_ENABLED` (see [ENVIRONMENT.md](./ENVIRONMENT.md#opentelemetry-tracing-issue-203)) | `src/lib/tracing.ts` |

### Two existing risky features are now gated (issue #201)

- **Batch recheck** (`batch_recheck`). Previously any maintainer `POST` to
  `/api/contributors` fanned out a Horizon call per contributor with no kill
  switch. Now it returns `403 { "error": "Batch recheck is currently disabled" }`
  when the flag is off.
- **Invite generation** (`invite_generation`). `/api/invites/generate` now
  returns `403 { "error": "Invite generation is currently disabled" }` when the
  flag is off, so invite issuance can be frozen during a Wave.

---

## Usage

```ts
import { isFeatureEnabled } from "@/lib/feature-flags";

if (!(await isFeatureEnabled("batch_recheck"))) {
  return NextResponse.json({ error: "Batch recheck is currently disabled" }, { status: 403 });
}
```

Edge middleware (no DB, no `server-only`):

```ts
import { isFeatureEnabledFromEnv } from "@/lib/feature-flags";
```

Admin / debug view:

```ts
import { getAllFeatureFlags, setFeatureFlag } from "@/lib/feature-flags";

const flags = await getAllFeatureFlags(); // [{ key, enabled, source, risky, description }]
await setFeatureFlag("batch_recheck", false, session.user.id); // requires FEATURE_FLAGS_DB_ENABLED
```

---

## Database source

Enable with `FEATURE_FLAGS_DB_ENABLED=1` and apply the migration
(`prisma/migrations/20260829120000_add_feature_flag_model`). Rows are keyed by
the flag name:

```sql
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('batch_recheck', false, now())
ON CONFLICT ("key") DO UPDATE SET "enabled" = excluded."enabled", "updatedAt" = now();
```

When `FEATURE_FLAGS_DB_ENABLED` is unset, the table is never queried.
