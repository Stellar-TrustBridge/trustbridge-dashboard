# Performance and load testing

This project includes k6 load test scripts to validate p95 latency thresholds
under simulated Wave payout traffic.

> **Warning:** do not point load tests at public Horizon from a load test
> without a controlled local or testnet fixture. Run against a local dev
> instance (`npm run dev`) or a dedicated staging environment only.
>
> **Never run k6 against production.**

---

## Prerequisites

- k6 installed locally: `brew install k6` or follow the [k6 installation guide](https://k6.io/docs/get-started/installation/)
- A local app instance running on `http://localhost:3000` (`npm run dev`)
- A non-public Horizon target or a stubbed Horizon server for the `POST /api/check` path

---

## Script 1 — contributors-check-load.js

`scripts/k6/contributors-check-load.js` — covers two endpoints:

- `POST /api/check` — public address validation (tagged `check`)
- `GET /api/contributors/paginated?limit=25` — maintainer contributor list (tagged `contributors`)

### Run

```bash
npm run test:k6
```

This runs with sensible defaults: 5 virtual users, 30 s duration, against
`http://localhost:3000`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:3000` | Base URL of the running app |
| `TEST_ADDRESS` | `GAS4JQ3KQH84GJ5VJ3M9S6D6A8Y8E5D7Q7XQ5K7ZJ5QZ2NR4Q6X7K4X` | Stellar G-address sent to `POST /api/check` |
| `VUS` | `5` | Number of virtual users |
| `DURATION` | `30s` | Test duration (k6 duration string, e.g. `60s`, `2m`) |

```bash
# Higher load, longer duration, custom address
BASE_URL=http://localhost:3000 \
TEST_ADDRESS=GBMZMYABCDEF... \
VUS=20 \
DURATION=2m \
npm run test:k6
```

### Running directly with k6

```bash
BASE_URL=http://localhost:3000 \
TEST_ADDRESS=GBMZMYABCDEF... \
VUS=5 \
DURATION=30s \
k6 run scripts/k6/contributors-check-load.js
```

### Thresholds

- `http_req_failed` < 2%
- `http_req_duration` p95 < 800 ms
- `checks` success rate > 95%

---

## Script 2 — treasury-export-load.js (Issue #517)

`scripts/k6/treasury-export-load.js` — Wave payout window load validation.
Covers five scenarios:

| Scenario tag | Endpoint | Auth |
|---|---|---|
| `treasury_export_get` | `GET /api/treasury/export` | Maintainer session cookie |
| `treasury_export_post` | `POST /api/treasury/export` | Maintainer session cookie |
| `contributors_paginated` | `GET /api/contributors/paginated` | Maintainer session cookie |
| `contributors_csv` | `GET /api/contributors/export/csv` | API key bearer (`tb_…`) |
| `cron_export` | `POST /api/cron/export` | `CRON_SECRET` bearer |

### Auth requirements

**CSRF:** The `assertSameOrigin` CSRF middleware allows requests from
non-browser clients that send no `Origin` or `Referer` header. k6 sends
neither, so all mutating requests pass CSRF validation automatically — no
token injection is required.

**Maintainer session:** endpoints 1–3 gate on `getServerSession` from
NextAuth. k6 must present the session cookie value obtained from a staging
sign-in. See [docs/ENVIRONMENT.md — TEST_SESSION_COOKIE](./ENVIRONMENT.md#test_session_cookie).

**API key bearer:** endpoint 4 accepts a `tb_…` API key with scope
`export:read`. See [docs/ENVIRONMENT.md — TEST_API_KEY](./ENVIRONMENT.md#test_api_key).

**CRON_SECRET bearer:** endpoint 5 accepts `Authorization: Bearer $CRON_SECRET`.
See [docs/ENVIRONMENT.md — TEST_CRON_SECRET](./ENVIRONMENT.md#test_cron_secret).

### Environment variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `BASE_URL` | `http://localhost:3000` | No | Base URL of the running app |
| `VUS` | `5` | No | Number of virtual users |
| `DURATION` | `30s` | No | Test duration (e.g. `30s`, `2m`) |
| `TEST_SESSION_COOKIE` | _(empty)_ | For scenarios 1–3 | Raw `next-auth.session-token` cookie value from a maintainer sign-in |
| `TEST_API_KEY` | _(empty)_ | For scenario 4 | `tb_…` API key with `export:read` scope |
| `TEST_CRON_SECRET` | _(empty)_ | For scenario 5 | Server's `CRON_SECRET` value |
| `EXPORT_LIMIT` | `25` | No | Page size for treasury export GET/POST |
| `CONTRIBUTORS_LIMIT` | `25` | No | Page size for paginated contributor list |
| `EXPORT_FORMAT` | `json` | No | `"json"` or `"csv"` for export POST format |
| `SKIP_SESSION_SCENARIOS` | _(unset)_ | No | Set to any non-empty value to skip session-gated scenarios (scenarios 1–3) |

### Thresholds

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| `http_req_failed` | < 5% overall | Baseline failure budget across all scenarios |
| `http_req_duration{scenario:treasury_export_get}` p95 | < 3000 ms | Export may aggregate large tables |
| `http_req_duration{scenario:treasury_export_post}` p95 | < 3000 ms | Export may aggregate large tables |
| `http_req_duration{scenario:contributors_paginated}` p95 | < 1500 ms | Paginated read; should be fast |
| `http_req_duration{scenario:contributors_csv}` p95 | < 1500 ms | Full CSV export |
| `http_req_duration{scenario:cron_export}` p95 | < 5000 ms | Triggers full DB sweep + optional email |
| `checks` | > 90% | Allows for expected 401/403 in CI smoke runs without secrets |

### Run — all scenarios

```bash
BASE_URL=http://localhost:3000 \
  TEST_SESSION_COOKIE="<next-auth.session-token value>" \
  TEST_API_KEY="tb_Abc123..." \
  TEST_CRON_SECRET="<cron-secret>" \
  VUS=5 \
  DURATION=30s \
  k6 run scripts/k6/treasury-export-load.js
```

### Run — API-key scenario only (no session needed)

Useful in CI pipelines where session cookies are unavailable:

```bash
BASE_URL=http://localhost:3000 \
  TEST_API_KEY="tb_Abc123..." \
  VUS=5 \
  DURATION=30s \
  k6 run --env SKIP_SESSION_SCENARIOS=1 scripts/k6/treasury-export-load.js
```

### Run — cron-secret scenario only

```bash
BASE_URL=http://localhost:3000 \
  TEST_CRON_SECRET="<cron-secret>" \
  VUS=2 \
  DURATION=30s \
  k6 run --env SKIP_SESSION_SCENARIOS=1 scripts/k6/treasury-export-load.js
```

### Example output

```
  ✓ treasury export GET: status is 200 or 403 (no session)
  ✓ treasury export GET: not a server error
  ✓ contributors paginated: status is 200 or 403
  ✓ contributors CSV: status is 200, 401, or 429
  ✓ cron export: status is 200, 403, or 502

  scenarios: (100.00%) 1 scenario, 5 max VUs, 1m0s max duration (incl. graceful stop):
           * default: 5 looping VUs for 30s (gracefulStop: 30s)

  ✓ checks.........................: 100.00% ✓ 250  ✗ 0
  ✓ http_req_duration..............: avg=341ms min=87ms med=312ms max=1.1s p(90)=543ms p(95)=891ms
  ✓ http_req_failed................: 0.00%   ✓ 0    ✗ 100
  ✓ http_req_duration{scenario:treasury_export_get}..: p(95)=950ms  threshold: 3000ms ✓
  ✓ http_req_duration{scenario:contributors_csv}.....: p(95)=1.1s   threshold: 1500ms ✓
  ✓ http_req_duration{scenario:cron_export}..........: p(95)=2.3s   threshold: 5000ms ✓
```

### Edge cases

| Scenario | What the script does |
|---|---|
| `TEST_SESSION_COOKIE` missing | Scenarios 1–3 receive 403; check asserts this is expected. Threshold still met if < 10% overall checks fail. |
| `TEST_API_KEY` missing | Scenario 4 receives 401; check asserts this is expected. |
| `TEST_CRON_SECRET` missing | Scenario 5 receives 403; check asserts this is expected. |
| Rate limit 429 on CSV export | Check asserts `Retry-After` header is present; counted as not-failed. |
| Stale-data guard 409 on POST | Check asserts `reason` field in body; counted as not-failed. |
| Large export timeout | Script sets `timeout: '15s'` per request; increase for very large datasets. |

### Grafana integration

All requests are tagged with `scenario` and `name` labels so they appear as
discrete series in Grafana when using the k6 Prometheus or InfluxDB output:

```bash
# Stream metrics to Prometheus remote-write
k6 run --out experimental-prometheus-rw \
  scripts/k6/treasury-export-load.js

# Or InfluxDB / Grafana Cloud k6
k6 run --out influxdb=http://localhost:8086/k6 \
  scripts/k6/treasury-export-load.js
```

See [docs/grafana/README.md](./grafana/README.md) for the pre-built dashboard
JSON files that include k6 panels.

---

## Secrets hygiene reminder

| Variable | Never commit to | Safe to store in |
|---|---|---|
| `TEST_SESSION_COOKIE` | `.env.local`, `.env`, git | CI secrets store, shell export only |
| `TEST_API_KEY` | Anywhere in repo | CI secrets store, shell export only |
| `TEST_CRON_SECRET` | Anywhere in repo | CI secrets store, shell export only |

Revoke test API keys and clear session cookies immediately after testing. See
[docs/API_KEYS.md](./API_KEYS.md) for key rotation guidance.
