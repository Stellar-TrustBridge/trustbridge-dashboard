# Horizon Retry Notes

Horizon is an external dependency, so transient failures should be visible without confusing contributors.

## Circuit breaker

`src/lib/circuit-breaker.ts` wraps Horizon calls with a state-machine breaker (CLOSED → OPEN → HALF_OPEN → CLOSED):

| Config env var | Default | Description |
|----------------|---------|-------------|
| `HORIZON_CB_FAILURE_THRESHOLD` | 5 | Consecutive failures before opening |
| `HORIZON_CB_RECOVERY_MS` | 30000 | Milliseconds to wait before probing recovery |
| `HORIZON_CB_SUCCESS_THRESHOLD` | 2 | Successful probe calls required to close again |

When the breaker is **OPEN**, `checkStellarAddress` returns a `not_ready` result with the message:

> "Horizon is temporarily unavailable. Please try again later."

This prevents wasted network calls, protects Horizon rate limits, and keeps the maintainer batch re-check (`POST /api/contributors`) from stalling when Horizon is down.

## Batch re-check concurrency

`refreshAllContributors` (`src/lib/registrations.ts`) re-checks every registration through a small worker pool instead of firing one Horizon request per contributor at once — at 100+ contributors, an unbounded burst risks tripping Horizon rate limits.

| Config env var | Default | Description |
|----------------|---------|-------------|
| `HORIZON_BATCH_CONCURRENCY` | 5 | Max registrations rechecked concurrently during a batch re-check |

A failure on one registration (e.g. a transient DB error persisting the result) is recorded in the batch summary's `errors` array and does not abort the rest of the batch.

## Retryable cases

- Rate limiting.
- Temporary upstream errors.
- Request timeouts.

## Product behavior

When checks cannot complete, show a not-ready state with a clear Horizon availability message. Avoid marking an account ready from stale data immediately before payout export.

## Related docs

- [Architecture overview](../docs/ARCHITECTURE.md)
- [Environment variables](../docs/ENVIRONMENT.md)

## Horizon Mock Server & Shared WireMock Fixtures

To ensure the TrustBridge Dashboard's contract with Stellar Horizon matches the payload shapes in `trustbridge-action`, shared WireMock stub mappings are maintained in `mock/horizon/mappings/`.

### Mapping Source & Schema Parity

The stub mappings are synced from `trustbridge-action` (`mock/horizon/mappings`):
- `account-funded.json`: Account with sufficient native XLM balance and authorized USDC trustline.
- `account-low-balance.json`: Account with USDC trustline but low native XLM balance below minimum reserve.
- `account-no-trustline.json`: Funded account without USDC trustline established.
- `account-unfunded.json`: Non-existent account returning 404 `Resource Missing`.
- `rate-limited.json`: Rate limited Horizon response (429) returning `Retry-After`.
- `health.json`: Root health check and version probe.

### Running WireMock Locally

You can spin up the mock WireMock server via Docker Compose:

```bash
docker compose -f mock/horizon/docker-compose.yml up -d
```

### Running Mock Contract Tests

Run the dedicated contract integration tests against the shared mock fixtures:

```bash
npm run test:mock
```

In CI, the `horizon-mock` workflow job automatically runs these tests on every pull request to ensure no regressions occur without requiring a live Stellar testnet connection.
