# Performance and load testing

This project includes a minimal k6 smoke test for the public address check endpoint and the maintainer contributor list endpoint.

> Warning: do not point the check endpoint at public Horizon from a load test without a controlled local or testnet fixture. The test should exercise a local app instance with a non-mainnet Horizon endpoint or a mocked Horizon service.

## Prerequisites

- k6 installed locally: `brew install k6` or `curl https://dl.k6.io/key.gpg` ...
- A local app instance on `http://localhost:3000`
- A non-public Horizon target or a stubbed Horizon server for the `POST /api/check` path

## Run the smoke test

```bash
BASE_URL=http://localhost:3000 TEST_ADDRESS=GAS4JQ3KQH84GJ5VJ3M9S6D6A8Y8E5D7Q7XQ5K7ZJ5QZ2NR4Q6X7K4X VUS=5 DURATION=30s k6 run scripts/k6/contributors-check-load.js
```

## Recommended thresholds

- `http_req_failed` < 2%
- `http_req_duration` p95 < 800 ms
- `checks` success rate > 95%

The script is intentionally small and should be run against a local app environment only. If you use a real Horizon network in dev, keep the virtual user count low and the duration short.
