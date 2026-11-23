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
