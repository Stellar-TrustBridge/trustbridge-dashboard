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

## Contributor list p95 targets

`GET /api/contributors/paginated` has a documented **p95 latency target of 1500 ms** under the stated hardware and roster size. This target is enforced by the k6 thresholds in both scripts 2 and 3 above.

### Hardware and load assumptions

| Component | Assumption |
|---|---|
| Dashboard host | Vercel Hobby/Pro — Node.js serverless function |
| PostgreSQL | Neon / Supabase free tier with connection pooling enabled |
| Contributor roster | Up to ~500 active registrations |
| Concurrent maintainer sessions | Up to 5 |

Exceeding these assumptions (larger rosters, no connection pool, unindexed queries) will push p95 past the threshold. Run the k6 suite before opening a Wave to confirm the deployment meets the target.

### Measuring without k6

Every `GET /api/contributors/paginated` response includes an `x-response-time-ms` header with the handler's wall-clock duration. Use it to spot-check latency without a full APM setup:

```bash
# Single measurement
curl -sI "https://your-dashboard.vercel.app/api/contributors/paginated?limit=25" \
  -H "Cookie: next-auth.session-token=<token>" \
  | grep x-response-time-ms
# x-response-time-ms: 142

# Rough p95 over 20 sequential requests (bash/awk)
for i in $(seq 1 20); do
  curl -so /dev/null -w "%{time_total}\n" \
    "https://your-dashboard.vercel.app/api/contributors/paginated?limit=25" \
    -H "Cookie: next-auth.session-token=<token>"
done | sort -n | awk 'NR==19{printf "p95: %.0fms\n", $1*1000}'
```

### Registration submit p95 target

`POST /api/register` (the registration-spike scenario) has a **p95 latency target of 3000 ms** because it includes a Horizon `loadAccount` call, a database upsert, and cache invalidation. This is enforced by the `registration_spike` threshold in script 3.

### Failure modes

| Symptom | Likely cause | Remediation |
|---|---|---|
| `contributors_paginated` p95 > 1500 ms | Missing index on `(deletedAt, id)` | Apply migration; run `CREATE INDEX CONCURRENTLY` on `Registration` |
| p95 spikes during recheck | `prisma.registration.count` scan | Ensure the route uses `where: { deletedAt: null }` (it does) |
| Degraded under concurrent load | Connection exhaustion | Enable Neon/Supabase pooler or Prisma Accelerate; see [DEPLOYMENT.md](./DEPLOYMENT.md#monitoring--limits) |
| `registration_spike` p95 > 3000 ms | Horizon cold calls or rate limiting | Use a non-public Horizon fixture; ensure the test IP is not rate-limited |
