# Performance Testing

This document describes reproducible load scenarios for TrustBridge
performance-sensitive subsystems. Each scenario lists setup, load profile,
success criteria, metrics to watch, and the exact commands to reproduce it.

> All scenarios run against a **local or staging** environment only. Never
> point load generators at production. Use throwaway orgs and testnet Stellar
> keys; do not commit secrets.

---

## Outbox worker: sustained drain

Exercises `processSorobanOutbox` in `src/lib/soroban-outbox-worker.ts` under a
sustained backlog so we know the worker converges instead of falling behind
before a Wave launch.

### What it covers

- Sustained enqueue + drain of `SorobanOutbox` rows (`status: PENDING`).
- Claim/`PROCESSING` transition, `COMPLETED` on success, retry with
  `nextAttemptAt` backoff, and `FAILED` (dead-letter) after `maxAttempts`.
- Idempotency: replaying a `FAILED` row via
  `replayFailedSorobanOutboxEntry` resets `attempts`/`lastError` and re-drains.
- Org scoping: `maintainerOrgId` limits the batch to a single org.

### Setup

1. Start the app and a Postgres instance (see `docs/DEPLOYMENT.md`).
2. Seed a dedicated test org and a batch of registrations. Example seed
   (adjust to your fixtures):

   ```bash
   export OUTBOX_TEST_ORG_ID="org_perf_outbox"
   export OUTBOX_TEST_ROWS=5000
   pnpm tsx scripts/seed-outbox-perf.ts \
     --org "$OUTBOX_TEST_ORG_ID" \
     --rows "$OUTBOX_TEST_ROWS"
   ```

   The seed inserts `SorobanOutbox` rows with `status: PENDING`,
   `attempts: 0`, and `nextAttemptAt <= now()` so they are immediately
   eligible for draining.

3. Point the worker at a **stub** Soroban mirror (or testnet) so the load test
   measures the worker, not the network. Set the same env vars the worker
   reads in `docs/DEPLOYMENT.md` (e.g. `SOROBAN_RPC_URL`,
   `SOROBAN_CONTRACT_ID`, `SOROBAN_NETWORK_PASSPHRASE`).

### Load profile

- **Backlog:** 5,000 pending rows for one org (scale to 20,000 for a stress
  run).
- **Drain loop:** call `processSorobanOutbox({ maintainerOrgId, batchSize })`
  repeatedly until `getSorobanOutboxMetrics(orgId).pending === 0` or the
  timeout is hit.
- **Batch sizes:** run at `batchSize: 10` (default) and `batchSize: 50`.
- **Failure mix:** 5% of rows are seeded to fail permanently (bad address) to
  exercise retry/backoff and dead-lettering; 2% fail once then succeed to
  exercise recovery.
- **Duration:** cap each run at 10 minutes.

Reproduce the drain loop:

```bash
OUTBOX_TEST_ORG_ID="org_perf_outbox" \
OUTBOX_BATCH_SIZE=10 \
pnpm tsx scripts/drain-outbox-perf.ts
```

The script loops `processSorobanOutbox` and prints a metrics snapshot each
iteration via `getSorobanOutboxMetrics`.

### Success criteria

| Metric | Target |
| --- | --- |
| Drain throughput | >= 50 rows/sec at `batchSize: 10` |
| Backlog convergence | `pending` reaches 0 within 10 min for 5,000 rows |
| Drain latency (p95) | <= 2s per batch |
| Unexpected error rate | 0 unhandled errors (only seeded failures) |
| Dead-letter count | equals seeded permanent-failure count (5%) |
| Idempotency | replaying a `FAILED` row completes exactly once |
| Org isolation | no rows from other orgs are claimed |

### Metrics to watch

- `getSorobanOutboxMetrics(orgId)` — `total`, `pending`, `processing`,
  `completed`, `failed`. `processing` should return to 0 after each batch;
  a stuck `processing` count signals a claim that never resolved.
- Worker logs (`subsystem: soroban-outbox-worker`): `soroban_outbox_tick`,
  `soroban_outbox_job_done`, `soroban_outbox_job_failed`.
- `listSorobanOutboxDeadLetters(orgId)` — dead-letter rows and their
  redacted `lastError`.
- DB: `SorobanOutbox.attempts` and `nextAttemptAt` for retry backoff.

### Failure paths to verify

1. **Permanent failure** — a row that always fails reaches `FAILED` after
   `maxAttempts` and appears in `listSorobanOutboxDeadLetters`.
2. **Transient failure** — a row that fails once is retried after
   `nextAttemptAt` and eventually `COMPLETED`.
3. **Replay** — `replayFailedSorobanOutboxEntry(id, orgId)` moves a `FAILED`
   row back to `PENDING` with `attempts: 0`; the next drain completes it.
4. **Pause/freeze** — while the org is paused/frozen, no new privileged
   state is written; the worker leaves rows `PENDING` and resumes cleanly.

### Operator risk note

A sustained drain holds DB connections and CPU for the duration of the run.
Run it off-peak on staging, watch `processing` for stuck claims, and confirm
`failed` matches the seeded failure count before trusting the result.

---

# Performance and load testing

This project includes k6 scripts that validate latency thresholds under Wave
payout traffic, registration spikes, and maintainer dashboard reads.

> **Warning:** run these tests only against a local dev instance (`npm run dev`)
> or a dedicated staging environment with a non-public Horizon fixture.
> **Never run k6 against production or public Horizon.**

---

## Prerequisites

- k6 installed locally: `brew install k6` or follow the [k6 installation guide](https://k6.io/docs/get-started/installation/)
- A local app instance running on `http://localhost:3000`
- A non-public Horizon target or a stubbed Horizon server (`HORIZON_URL` /
  Horizon mock), because registration and check requests call `loadAccount`
- Session cookies obtained from a staging sign-in, exported in the shell (never
  committed — see [Secrets hygiene](#secrets-hygiene))
- `VUS` and `DURATION` are honored by all npm scripts; values are passed through
  to k6 as `__ENV` values

---

## Script 1 — contributors-check-load.js (`/api/check` rate limiting)

`scripts/k6/contributors-check-load.js` covers **one** endpoint:

| Scenario | Endpoint | Purpose |
|---|---|---|
| `steady` | `POST /api/check` | happy path, stays under the rate limit |
| `burst` | `POST /api/check` | fan-out above the limit to exercise `429` + headers |

It does **not** exercise the paginated contributor list. That endpoint is
covered by scripts 2 and 3 below.

### Run

```bash
npm run test:k6
# equivalent:
BASE_URL=http://localhost:3000 TEST_ADDRESS=G... VUS=5 DURATION=30s \
  k6 run scripts/k6/contributors-check-load.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Base URL of the running app |
| `TEST_ADDRESS` | `GAS4JQ3KQH84GJ5VJ3M9S6D6A8Y8E5D7Q7XQ5K7ZJ5QZ2NR4Q6X7K4X` | Stellar G-address sent to `POST /api/check` (must be valid for your Horizon fixture) |
| `CSRF_TOKEN` | `wave-load-token` | Value of the `x-csrf-token` header |
| `BURST_VUS` | `20` | Virtual users in the burst scenario |
| `BURST_ITERATIONS` | `5` | Iterations per burst VU |
| `VUS` / `DURATION` | `5` / `30s` | Accepted by the npm script for consistency; script 1 uses the fixed scenario definitions above |

### Thresholds (as defined in the script)

| Metric | Threshold |
|---|---|
| `http_req_failed{scenario:steady}` | `rate<0.01` |
| `allowed_responses{scenario:steady}` | `rate>0.99` |
| `rate_limited_responses{scenario:burst}` | `rate>0` |
| `rate_limit_headers_present` | `rate>0.99` |

---

## Script 2 — treasury-export-load.js (Wave payout window)

`scripts/k6/treasury-export-load.js` covers five scenarios:

| Scenario tag | Endpoint | Auth |
|---|---|---|
| `treasury_export_get` | `GET /api/treasury/export` | Maintainer session cookie |
| `treasury_export_post` | `POST /api/treasury/export` | API key bearer or operator session |
| `contributors_paginated` | `GET /api/contributors/paginated` | Maintainer session cookie |
| `contributors_csv` | `GET /api/contributors/export/csv` | API key bearer (`tb_…`) |
| `cron_export` | `POST /api/cron/export` | `CRON_SECRET` bearer |

### Run

```bash
BASE_URL=http://localhost:3000 \
  TEST_SESSION_COOKIE="<next-auth.session-token value>" \
  TEST_API_KEY="tb_Abc123..." \
  TEST_CSRF_ORIGIN="http://localhost:3000" \
  TEST_CRON_SECRET="<cron-secret>" \
  VUS=5 DURATION=30s \
  npm run test:k6:treasury

# API-key scenarios only (no session needed)
TEST_API_KEY="tb_Abc123..." VUS=5 DURATION=30s \
  k6 run --env SKIP_SESSION_SCENARIOS=1 scripts/k6/treasury-export-load.js
```

### Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `BASE_URL` | `http://localhost:3000` | No | Base URL of the running app |
| `VUS` | `5` | No | Virtual users |
| `DURATION` | `30s` | No | Test duration (e.g. `30s`, `2m`) |
| `TEST_SESSION_COOKIE` | _(empty)_ | Scenarios 1 and 3 | Raw `next-auth.session-token` value from a maintainer sign-in |
| `TEST_API_KEY` | _(empty)_ | Scenarios 2 and 4 | `tb_…` API key with `export:read` scope |
| `TEST_CSRF_ORIGIN` | `BASE_URL` | No | Same-origin `Origin` header for `POST /api/treasury/export` |
| `TEST_CRON_SECRET` | _(empty)_ | Scenario 5 | Server's `CRON_SECRET` value |
| `EXPORT_LIMIT` | `25` | No | Page size for treasury export GET/POST |
| `CONTRIBUTORS_LIMIT` | `25` | No | Page size for paginated contributor list |
| `EXPORT_FORMAT` | `json` | No | `json` or `csv` for export POST |
| `SKIP_SESSION_SCENARIOS` | _(unset)_ | No | Skip scenarios 1, 3 and 5 |

### Thresholds (as defined in the script)

| Metric | Threshold |
|---|---|
| `http_req_failed` | `rate<0.05` |
| `http_req_duration{scenario:treasury_export_get}` p95 | `<3000` ms |
| `http_req_duration{scenario:treasury_export_post}` p95 | `<3000` ms |
| `http_req_duration{scenario:contributors_paginated}` p95 | `<1500` ms |
| `http_req_duration{scenario:contributors_csv}` p95 | `<1500` ms |
| `http_req_duration{scenario:cron_export}` p95 | `<5000` ms |
| `checks` | `rate>0.95` |

---

## Script 3 — registration-open-day-load.js (Issue #687)

`scripts/k6/registration-open-day-load.js` models contributor sign-ups opening
day together with maintainer reads. Both scenarios run for `DURATION` with `VUS`
virtual users each, and every request carries a `scenario` tag.

| Scenario tag | Endpoint | Auth | Request |
|---|---|---|---|
| `registration_spike` | `POST /api/register` | Contributor session cookie | `{ "stellarAddress": "<unique valid G-address>" }` |
| `contributors_paginated` | `GET /api/contributors/paginated?limit=25` | Maintainer session cookie | none |

Addresses are generated deterministically from `__VU`, `__ITER`, a monotonic
counter, and `Date.now()`, then encoded with a valid Stellar StrKey checksum, so
each request targets a unique address that passes `isValidStellarAddress`.

### Registration-specific requirements

- `POST /api/register` requires an **authenticated contributor session**.
  Export the raw `next-auth.session-token` cookie value as `TEST_SESSION_COOKIE`.
  An absent/invalid cookie produces `401`, failed checks, and failed requests.
- The route enforces `assertSameOrigin`: send `Origin: TEST_CSRF_ORIGIN` and
  `Referer: TEST_CSRF_REFERER` (defaults to `TEST_CSRF_ORIGIN/register`), both
  pointing at the same host as `BASE_URL`. Missing/mismatched values produce
  `403`.
- Registration calls Horizon (`loadAccount`) for each new address. Use a
  **non-public Horizon fixture or stub**; public Horizon will rate-limit or ban
  the test IP.
- Respect the **wave freeze window**: an active `FREEZE_WINDOW_*` configuration
  returns `423 Locked` (`WAVE_FREEZE_ACTIVE`) and fails the run. Schedule load
  tests outside the window or temporarily disable `FREEZE_WINDOW_ENABLED` on
  the test instance.
- Rate limits are **process-local** (`src/lib/rate-limit.ts` stores counters in
  an in-process `Map`). On multi-instance deployments each replica counts
  independently, so an observed `429` rate is per-instance, not cluster-wide.
  `409` means the address is already actively registered (allowed but tracked).

### Run

```bash
BASE_URL=http://localhost:3000 \
  TEST_SESSION_COOKIE="<contributor session-token value>" \
  TEST_MAINTAINER_SESSION_COOKIE="<maintainer session-token value>" \
  TEST_CSRF_ORIGIN="http://localhost:3000" \
  VUS=10 DURATION=1m \
  npm run test:k6:registration

# Direct k6 invocation
BASE_URL=http://localhost:3000 TEST_SESSION_COOKIE="..." \
  VUS=10 DURATION=1m \
  k6 run scripts/k6/registration-open-day-load.js
```

`TEST_MAINTAINER_SESSION_COOKIE` falls back to `TEST_SESSION_COOKIE` when
omitted. Use a separate maintainer cookie when the contributor account is not a
maintainer.

### Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `BASE_URL` | `http://localhost:3000` | No | Base URL of the running app |
| `TEST_SESSION_COOKIE` | _(empty)_ | Yes | Contributor `next-auth.session-token` value for `POST /api/register` |
| `TEST_MAINTAINER_SESSION_COOKIE` | `TEST_SESSION_COOKIE` | For paginated reads | Maintainer `next-auth.session-token` value |
| `TEST_CSRF_ORIGIN` | `BASE_URL` | No | Same-origin `Origin` header |
| `TEST_CSRF_REFERER` | `TEST_CSRF_ORIGIN/register` | No | Same-origin `Referer` header |
| `VUS` | `5` | No | Virtual users **per scenario** |
| `DURATION` | `30s` | No | Duration of each scenario |
| `CONTRIBUTORS_LIMIT` | `25` | No | Page size for the paginated read |

### Thresholds and success criteria

| Metric | Threshold | Meaning |
|---|---|---|
| `http_req_failed{scenario:registration_spike}` | `rate<0.05` | `401`/`403`/`5xx` are real failures; `409`/`429` are excluded via `expectedStatuses` |
| `http_req_duration{scenario:registration_spike}` p95 | `<3000` ms | Includes Horizon validation, DB upsert, and cache invalidation |
| `registration_accepted{scenario:registration_spike}` | `rate>0.90` | At least 90% of attempts return `2xx` |
| `registration_conflict{scenario:registration_spike}` | `rate<0.50` | Too many `409`s means the address generator or fixture is wrong |
| `registration_rate_limited{scenario:registration_spike}` | `rate<0.50` | Too many `429`s means the process-local limiter saturated |
| `http_req_failed{scenario:contributors_paginated}` | `rate<0.02` | Maintainer reads should almost always succeed |
| `http_req_duration{scenario:contributors_paginated}` p95 | `<1500` ms | Paginated reads are a lightweight DB query |
| `contributors_read_ok{scenario:contributors_paginated}` | `rate>0.95` | 200s dominate the read scenario |
| `checks` | `rate>0.95` | All response-shape and session checks pass |

A run passes only when **every** threshold is green. Failing session-cookie
checks, a frozen roster, or public Horizon cause `checks`/`http_req_failed`
regressions rather than a silently green run.

---

## How to read k6 metrics

- **`checks`** — the percentage of `check()` assertions that passed. Track the
  failing check name in the k6 output; a session cookie or CSRF failure shows up
  here first.
- **`http_req_failed`** — the fraction of requests k6 considers failed. Expected
  `409`/`429` responses are declared with `http.expectedStatuses(...)` so they
  do not inflate this number. Watch the scenario-tagged variant to localize a
  regression.
- **`http_req_duration{scenario:<name>}` p95** — 95th-percentile end-to-end
  latency for one scenario. `p(95)<1500` means 95% of requests complete in under
  1.5 s. Use the scenario tag to tell registration writes apart from paginated
  reads; compare against the threshold table above.
- **Custom rate metrics** — `registration_accepted`, `registration_conflict`,
  `registration_rate_limited`, `contributors_read_ok`, `allowed_responses`,
  `rate_limited_responses`, and `rate_limit_headers_present` report the share of
  requests in a given category. They explain *why* a latency or failure
  threshold moved (for example a rising `registration_rate_limited` rate).

To export the metrics to Grafana for trend analysis:

```bash
k6 run --out experimental-prometheus-rw \
  scripts/k6/registration-open-day-load.js
```

See [docs/grafana/README.md](./grafana/README.md) for pre-built dashboards.

---

## Secrets hygiene

| Variable | Never commit to | Safe to store in |
|---|---|---|
| `TEST_SESSION_COOKIE` | `.env.local`, `.env`, git | CI secrets store, shell export only |
| `TEST_MAINTAINER_SESSION_COOKIE` | Anywhere in repo | CI secrets store, shell export only |
| `TEST_API_KEY` | Anywhere in repo | CI secrets store, shell export only |
| `TEST_CRON_SECRET` | Anywhere in repo | CI secrets store, shell export only |

Revoke test API keys and clear session cookies immediately after testing. See
[docs/API_KEYS.md](./API_KEYS.md) for key rotation guidance.

---

## Stats endpoint single-flight coalescing

`GET /api/stats` is the most-read public endpoint — it is polled by the
landing page, the maintainer dashboard, and CDN re-validation requests
simultaneously.  During open-registration day this means hundreds of requests
can arrive while the in-process `statsCache` is cold (after first deploy, after
a TTL expiry, or after a cache invalidation triggered by a readiness change).

### The stampede problem

Without coalescing, every concurrent request that sees `statsCache.get(key) ===
null` calls `getDashboardStats()` independently.  Each call issues:

```sql
SELECT funded, trustlineReady, trustlineAuthorized, xlmBalance, spendableXlmBalance
FROM "Registration"
WHERE "deletedAt" IS NULL;
```

On a 500-contributor roster that is 500 rows per request.  100 concurrent
cold-cache requests fan this out to 100 simultaneous full-table scans — a
stampede that melts the Wave DB connection pool.

### The fix — single-flight in `CacheStore.getOrCompute`

`src/lib/cache.ts`'s `CacheStore.getOrCompute` now tracks in-flight factory
promises in an internal `inflight: Map<string, Promise<T>>`.  When a second
(or Nth) caller reaches a cold key while the first factory call is still
running, it receives the **same** promise rather than starting a new one.  All
callers resolve together when the factory completes; only one DB query is
issued.

Error semantics are preserved: if the factory rejects, the in-flight entry is
deleted so the next caller can retry rather than replaying the rejection.

### Testing

```bash
# Run only the stampede tests
npx vitest run src/lib/stats-cache.test.ts

# Sample passing output
 ✓ cache stampede prevention (single-flight coalescing) > concurrent cold misses call the factory exactly once (happy path)
 ✓ cache stampede prevention (single-flight coalescing) > a second wave after the first completes does not call the factory again (cached hit)
 ✓ cache stampede prevention (single-flight coalescing) > a factory error is not coalesced — subsequent callers retry (failure path)
 ✓ cache stampede prevention (single-flight coalescing) > independent keys do not share in-flight state
 ✓ cache stampede prevention (single-flight coalescing) > after invalidation concurrent callers re-coalesce onto a single new factory call
 ✓ statsCache singleton — single-flight stampede guard > 100 concurrent cold misses call the DB factory exactly once
 ✓ statsCache singleton — single-flight stampede guard > DB outage during cold miss leaves no partial state; next call retries
```

### Wave operator risk note

This change is additive and backward-compatible.  The only observable difference
is that a cold cache under concurrent load now results in one DB query instead
of N.  Callers that relied on each `getOrCompute` call always invoking the
factory (e.g. integration tests that do not await concurrently) continue to
work because a sequential second call after the first resolves hits the warm
cache, not the in-flight path.

The `inflight` map is cleared by `CacheStore.reset()` / `clear()`, so test
isolation is unaffected.  In production, `reset()` is never called on
`statsCache` directly; `invalidate(key)` or `invalidatePattern(regex)` are
used instead.

### Environment variable reference

| Variable | Default | Effect on stats endpoint |
|---|---|---|
| `STATS_CACHE_TTL_MS` | `60000` (60 s) | In-process TTL and HTTP `max-age`. Lower values increase DB query rate but reduce staleness. |

The rate limiter (`RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`) applies
upstream of the cache; a 429 response from the rate limiter never reaches the
DB at all.
