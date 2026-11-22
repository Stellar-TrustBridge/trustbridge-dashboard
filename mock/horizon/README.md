# Mock Horizon Server

This directory contains deterministic mock Horizon API stub mappings and Docker Compose configuration for TrustBridge.

## Mapping Source

These mappings are synchronized from `trustbridge-action` (`mock/horizon/mappings`) to guarantee schema parity between the GitHub Action runner and the TrustBridge Dashboard.

### Available Test Accounts

| Account Address | Status | XLM Balance | USDC Balance | Trustline |
|-----------------|--------|-------------|--------------|-----------|
| `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF` | Funded | 10.0 | 50.0 | Ready (USDC) |
| `GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB` | Unfunded (404) | 0.0 | 0.0 | None |
| `GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC` | Low Balance | 0.5 | 10.0 | Ready (USDC) |
| `GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD` | No Trustline | 10.0 | 0.0 | None |
| `GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE` | Rate Limited (429) | — | — | — |

## Running Locally

To spin up the WireMock instance on port `8089`:

```bash
docker compose -f mock/horizon/docker-compose.yml up -d
```

Run integration tests against the mock:

```bash
NEXT_PUBLIC_HORIZON_URL=http://localhost:8089 npm run test:mock
```

To stop:

```bash
docker compose -f mock/horizon/docker-compose.yml down
```

## Resource Limits

WireMock loads all stub mappings into memory at startup and keeps them resident. Under-resourced containers cause the JVM to thrash or get OOM-killed, which surfaces as flaky Wave check failures rather than an obvious error. The recommended limits (matching `docs/DOCKER_COMPOSE.md` and the annotations in `docker-compose.yml`) are:

| Service | CPU limit | Memory limit | Memory reservation |
|---------|-----------|--------------|--------------------|
| `horizon-mock` (WireMock) | `1.0` | `512M` | `256M` |

These are the minimums for a contributor laptop running the full Wave stack. If you run the mock alongside the dashboard, Postgres, and Redis, budget at least 2 GB of RAM for the compose project as a whole.

## OOM Troubleshooting

If the mock container exits unexpectedly or Wave checks fail intermittently, check for an out-of-memory kill:

```bash
# Exit code 137 (128 + SIGKILL) usually means the OOM killer fired
docker compose -f mock/horizon/docker-compose.yml ps -a

# Inspect the container's last state and exit code
docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' horizon-mock

# Kernel OOM killer events (Linux hosts)
dmesg -T | grep -i 'killed process'
```

Common symptoms:

- **Exit code 137 / `OOMKilled: true`** — the container exceeded its memory limit. Raise `mem_limit`/`deploy.resources.limits.memory` or stop other heavy containers.
- **Healthcheck failures / `unhealthy` status** — WireMock is still loading mappings or GC-thrashing. Increase the healthcheck `start_period` or the memory limit.
- **`OutOfMemoryError: Java heap space` in logs** — the JVM heap is too small for the loaded mappings. Raise the memory limit; the JVM sizes its heap from the container limit.
- **Slow or timing-out responses** — CPU starvation. Raise the CPU limit or reduce concurrent test workers.

After adjusting limits, recreate the container so the new limits apply:

```bash
docker compose -f mock/horizon/docker-compose.yml up -d --force-recreate
```
