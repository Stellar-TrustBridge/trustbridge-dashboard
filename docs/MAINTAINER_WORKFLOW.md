# Maintainer Workflow

This guide documents operational workflows for TrustBridge maintainers and treasurers, including the `trustbridge-dash` CLI, wave freeze windows, and payout verification.

---

## 1. CLI (`trustbridge-dash`)

The `trustbridge-dash` CLI allows maintainers and automated scripts to export payout data and initiate address rechecks without relying on browser UI sessions.

### Installation & Local Usage

The CLI is registered in `package.json` under `"bin"`:

```bash
# Direct execution via npm/npx or node
./scripts/cli/index.mjs --help
npx trustbridge-dash --help
```

### Commands

#### 1. Login / Credential Setup
Save the target URL and API key locally (stored in `~/.trustbridge/config.json` with `0600` permissions):
```bash
trustbridge-dash login --url https://dashboard.trustbridge.org --api-key <YOUR_API_KEY>
```

Alternatively, provide configuration via environment variables:
```bash
export TRUSTBRIDGE_API_URL="https://dashboard.trustbridge.org"
export TRUSTBRIDGE_API_KEY="<YOUR_API_KEY>"
```

#### 2. Treasury Export
Export contributor readiness and Stellar addresses in CSV (default) or JSON format:
```bash
# Export CSV to stdout or file
trustbridge-dash export --format csv --out ./treasury-export.csv

# Export JSON
trustbridge-dash export --format json --out ./treasury-export.json
```

API clients can request the same formats by POSTing `{"format":"csv"}` or
`{"format":"json"}` to `/api/treasury/export`. The endpoint requires an
operator session or an API key with the `export:read` scope and applies its
same-origin request check.

#### 3. Recheck
Trigger an address verification / readiness check:
```bash
# Batch recheck all contributors (asynchronous background queue)
trustbridge-dash recheck --all

# Recheck a single contributor
trustbridge-dash recheck --username octocat
```

### Security & Protocol Constraints
- **HTTPS Enforcement**: Unencrypted HTTP (`http://`) endpoints are strictly rejected by the CLI to protect API keys and contributor information.
- **Log Masking**: API keys and tokens are never printed in full to logs or error outputs.

---

## 2. Wave Roster Freeze Window

To prevent roster changes or rechecks from shuffling readiness states immediately prior to wave payout settlement:

- **Configuration**:
  - `FREEZE_WINDOW_START` (ISO 8601, e.g. `2026-08-30T00:00:00Z`).
  - `FREEZE_WINDOW_END` (ISO 8601, e.g. `2026-09-02T00:00:00Z`).
  - `FREEZE_WINDOW_ENABLED=true` (or `false` to disable).
- **Behavior**:
  - Mutating operations (`POST /api/register/recheck`, address updates in `POST /api/register`) are blocked during an active freeze window with HTTP `423 Locked` (`code: WAVE_FREEZE_ACTIVE`).
  - Read operations (`GET /api/register`, dashboard viewing) remain fully operational.
  - Blocked attempts are logged in the audit log as `recheck.freeze_blocked` / `address_change.freeze_blocked`.
- **Maintainer Override**:
  - Maintainers can bypass an active freeze window when necessary by supplying header `x-freeze-override: true` or query param `overrideFreeze=true`.
  - Override operations are recorded in the audit log as `recheck.freeze_override` / `address_change.freeze_override`.

---

## 2a. Replaying a GitHub org membership webhook

The maintainer-only replay endpoint reprocesses an already-observed membership payload. It requires the same-origin check, an authenticated maintainer session **and** a valid `X-Hub-Signature-256` HMAC for the exact raw request body (signed with `GITHUB_WEBHOOK_SECRET`). Missing or invalid signatures return HTTP `401`; non-maintainers and cross-origin requests return `403`.

```bash
BODY='{"action":"member_added","membership":{"user":{"id":1,"login":"octocat"}},"organization":{"login":"stellar-org"}}'
SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | awk '{print $2}')"

curl -X POST https://dashboard.example.com/api/webhooks/github-org-membership/replay \
  -H 'Content-Type: application/json' \
  -H "Origin: https://dashboard.example.com" \
  -H "x-hub-signature-256: $SIGNATURE" \
  -H "x-github-delivery: 123e4567-e89b-12d3-a456-426614174000" \
  --data-binary "$BODY"
```

Procedure:

1. Replay only after signature verification or a successful earlier ingestion — the payload is trusted only because the HMAC matches.
2. Forward the original `X-GitHub-Delivery` id so audit entries stay correlated. A successful response is HTTP `200` with `ok`, `replayed`, `handled`, `action`, `login` and `deliveryId`.
3. Deliveries are deduplicated for 24h in an **in-process** cache. A repeat with the same id returns `200` with `duplicate: true` and does not write to the database or audit log. To force a genuine reprocess, use a fresh delivery id (or restart the process, which clears the per-process cache).
4. The in-process membership cache follows `member_added`/`member_invited` → `true` and `member_removed` → `false`. It is only updated after HMAC verification.
5. Rotate `GITHUB_WEBHOOK_SECRET` per [SECURITY_POLINRIDER.md](./SECURITY_POLINRIDER.md#webhook-secret-rotation-runbook) before re-signing stored payloads; old signatures fail closed.

---

## 3. Horizon Latency Metrics

- The maintainer metrics dashboard aggregates `horizonLatencyMs` from Horizon address checks.
- Visualizes average latency, median (p50), p95 latency, and sample counts.
- Displays an empty state banner when no samples exist.

---

## 4. Contributor Ban & Unban Management

- Maintainers can ban an abusive or compromised contributor via the maintainer dashboard or `POST /api/maintainer/ban` (`action: "ban"`, `githubUsername: "<username>"`, `reason: "<mandatory reason>"`).
- Banning requires a non-empty reason and applies case-insensitively across current and future account re-registrations.
- Unban via `POST /api/maintainer/ban` (`action: "unban"`, `githubUsername: "<username>"`).
- All actions record audit trail events (`contributor.banned`, `contributor.unbanned`).

---

## 5. Soroban Event Cursor Reset

When operators need to re-index or re-sync Soroban events from a specific ledger or genesis:

1. **Inspect existing cursors**:
   ```sql
   SELECT "maintainerOrgId", "eventType", "cursor", "lastPagingToken", "lastSyncedAt"
   FROM "SorobanEventCursor"
   WHERE "maintainerOrgId" = '<maintainer_org>';
   ```

2. **Reset to a previous ledger/token**:
   ```sql
   UPDATE "SorobanEventCursor"
   SET "cursor" = '<target_ledger_or_token>',
       "lastPagingToken" = NULL,
       "lastSyncedAt" = NOW()
   WHERE "maintainerOrgId" = '<maintainer_org>' AND "eventType" = 'contract';
   ```

3. **Full re-sync from scratch**:
   Delete the cursor record to let the backfill worker start from genesis or the contract inception ledger:
   ```sql
   DELETE FROM "SorobanEventCursor"
   WHERE "maintainerOrgId" = '<maintainer_org>' AND "eventType" = 'contract';
   ```
