# Performance and load testing

This project includes a minimal k6 smoke test for the public address check endpoint and the maintainer contributor list endpoint.

> Warning: do not point the check endpoint at public Horizon from a load test without a controlled local or testnet fixture. The test should exercise a local app instance with a non-mainnet Horizon endpoint or a mocked Horizon service.

## Prerequisites

- k6 installed locally: `brew install k6` or follow the [k6 installation guide](https://k6.io/docs/get-started/installation/)
- A local app instance running on `http://localhost:3000` (`npm run dev`)
- A non-public Horizon target or a stubbed Horizon server for the `POST /api/check` path

## Run the smoke test

Use the `test:k6` npm script (recommended):

```bash
npm run test:k6
```

This runs with sensible defaults: 5 virtual users, 30 s duration, against `http://localhost:3000`.

### Overriding environment variables

All parameters are configurable via environment variables:

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

### Running directly with k6 (without npm)

If you need to pass k6-specific flags (e.g. `--out`, `--summary-export`), call k6 directly:

```bash
BASE_URL=http://localhost:3000 \
TEST_ADDRESS=GBMZMYABCDEF... \
VUS=5 \
DURATION=30s \
k6 run scripts/k6/contributors-check-load.js
```

## Recommended thresholds

The script enforces these thresholds automatically and fails the run if they are not met:

- `http_req_failed` < 2%
- `http_req_duration` p95 < 800 ms
- `checks` success rate > 95%

## Script location

`scripts/k6/contributors-check-load.js` — covers two endpoints:

- `POST /api/check` — public address validation (tagged `check`)
- `GET /api/contributors/paginated?limit=25` — maintainer contributor list (tagged `contributors`)

The script is intentionally small and should be run against a local app environment only. If you use a real Horizon network in dev, keep the virtual user count low and the duration short.
