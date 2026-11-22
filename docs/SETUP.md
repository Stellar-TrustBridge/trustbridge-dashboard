# Setup Guide

Step-by-step instructions to run TrustBridge Dashboard locally.

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md) and [Troubleshooting](./TROUBLESHOOTING.md)

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 18.17+ | LTS recommended |
| npm | 9+ | Comes with Node |
| PostgreSQL | 14+ | Local Docker, Neon, or Supabase |
| Git | any | For cloning |

---

## 1. Clone the repository

```bash
git clone https://github.com/your-org/trustbridge-dashboard.git
cd trustbridge-dashboard
npm install
```

---

## 2. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)
2. **New OAuth App**
3. Fill in:
   - **Application name:** TrustBridge Dashboard (Local)
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/api/auth/callback/github`
4. Copy **Client ID** and generate **Client Secret**

---

## 3. Set up PostgreSQL

### Option A: Docker

```bash
docker run --name trustbridge-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=trustbridge \
  -p 5432:5432 \
  -d postgres:16
```

`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trustbridge`

### Option B: Neon / Supabase

Create a project and copy the connection string from the dashboard.

---

## 4. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` — minimum required:

```bash
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=   # run: openssl rand -base64 32
TOKEN_ENCRYPTION_KEY=   # run: openssl rand -base64 32
GITHUB_MAINTAINER_ORG=your-github-org-slug
DATABASE_URL=postgresql://...
```

Full reference: [ENVIRONMENT.md](./ENVIRONMENT.md)

---

## 5. Initialize database schema

```bash
npm run db:push
```

For production-like migrations:

```bash
npm run db:migrate
```

Optional — open Prisma Studio:

```bash
npm run db:studio
```

---

## 6. Start development server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

---

## 7. Verify the setup

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `/` | Landing page loads, stats show 0 contributors |
| 2 | Click "Register your Stellar address" | GitHub OAuth flow |
| 3 | After sign-in, go to `/register` | Registration form visible |
| 4 | Enter a valid Stellar G-address | Live Horizon validation appears |
| 5 | Sign in as org member, visit `/dashboard` | Maintainer table (if `GITHUB_MAINTAINER_ORG` matches) |

---

## Troubleshooting

### `Environment variable not found: DATABASE_URL`

Ensure `.env.local` exists and `DATABASE_URL` is set. Restart `npm run dev`.

### GitHub OAuth redirect mismatch

Callback URL in GitHub App must exactly match `{NEXTAUTH_URL}/api/auth/callback/github`.

### Dashboard access denied

Your GitHub account must be a **public member** of the org set in `GITHUB_MAINTAINER_ORG`. Private membership may require a GitHub App with org read scope instead.

### Horizon validation errors

- Check `NEXT_PUBLIC_HORIZON_URL` (mainnet vs testnet)
- Ensure the G-address exists on the same network as Horizon
- Match the exact message you see to a cause and action in
  [Troubleshooting](./TROUBLESHOOTING.md#address-check-messages)

### Build fails on Prisma

Run `npx prisma generate` then `npm run build`.

---

## Next steps

- [Deploy to Vercel](./DEPLOYMENT.md)
- [Understand the architecture](./ARCHITECTURE.md)
- [Contribute](./CONTRIBUTING.md)

## Network variables now fail fast (#683)

Copy `.env.example` and set `NEXT_PUBLIC_HORIZON_URL` explicitly (mainnet
`https://horizon.stellar.org` or testnet
`https://horizon-testnet.stellar.org`). There is no silent boot-time default
anymore. If you set `SOROBAN_CONTRACT_ID`, also set `SOROBAN_RPC_URL` to an
http(s) endpoint on the same network, or boot will stop with a named error.
See [ENVIRONMENT.md — Boot-time network validation](./ENVIRONMENT.md#boot-time-network-validation-683).

---

## Appendix: Checklist idempotency keys (#688)

`PATCH /api/register/checklist` accepts an optional `Idempotency-Key` header
(8–128 chars, `[A-Za-z0-9_-]`) for retry-safe double submits. Keys are scoped
by org and user; the first successful response is replayed for **5 minutes**
(default; override with `CHECKLIST_IDEMPOTENCY_TTL_MS` in milliseconds) with
`X-Idempotent-Replay: true`. Requests without the header behave as before.
See [CHECKLIST_IDEMPOTENCY.md](./CHECKLIST_IDEMPOTENCY.md).

---

## Contract-sync prerequisites checklist

Before enabling contract-to-Postgres sync (`POST /api/contract-sync` or the
`runContractSync` cron job), verify every item below. A single misconfigured
value produces a different failure symptom — the table maps each gap to what
the operator will see so the right fix is applied first.

### Required variables

| Variable | Description | How to verify |
|----------|-------------|---------------|
| `SOROBAN_RPC_URL` | HTTP(S) endpoint for the Soroban RPC node | `curl -s "$SOROBAN_RPC_URL" -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \| jq .result.status` → `"healthy"` |
| `SOROBAN_CONTRACT_ID` | Bech32 Soroban contract address (starts with `C`) | `echo "$SOROBAN_CONTRACT_ID" \| wc -c` → 57 (56 chars + newline). Must be deployed on the same network as `SOROBAN_RPC_URL`. |
| `SOROBAN_NETWORK_PASSPHRASE` | Network passphrase matching `SOROBAN_RPC_URL` | Mainnet: `"Public Global Stellar Network ; September 2015"`. Testnet: `"Test SDF Network ; September 2015"`. A mismatch produces signature errors even when both URLs classify correctly. |

### Recommended variables

| Variable | Default | Notes |
|----------|---------|-------|
| `NEXT_PUBLIC_HORIZON_URL` | `https://horizon.stellar.org` | Must be on the **same** Stellar network as `SOROBAN_RPC_URL`. Dashboard shows a `network_config_mismatch_detected` warning and audit log entry when they diverge. |
| `CONTRACT_SYNC_MIN_INTERVAL_MS` | `60000` | Minimum ms between `/api/contract-sync` runs. Set higher (e.g. `300000`) for low-frequency schedulers to avoid RPC hammering. |
| `CONTRACT_SYNC_LAG_THRESHOLD_MS` | `900000` | Age of last successful sync considered "lagging". |
| `CONTRACT_SYNC_STALL_THRESHOLD_MS` | `3600000` | Age considered "stalled". |
| `CONTRACT_SYNC_ALERT_WEBHOOK_URL` | unset | HTTPS webhook for lag/stall alerts. |

### Failure symptoms linked to root causes

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| `contract_not_configured` in `GET /api/contract-sync` | `SOROBAN_CONTRACT_ID` unset | Set the variable and redeploy. |
| `rpc_error` with "Host not found" or ECONNREFUSED | `SOROBAN_RPC_URL` unreachable | Check the URL and any firewall rules. |
| `rpc_timeout` | RPC node overloaded or network latency | Increase `CONTRACT_SYNC_MIN_INTERVAL_MS`; consider a different RPC endpoint. |
| `rpc_auth_error` (401/403) | Private RPC endpoint requires auth credentials in URL | Embed credentials or use a public RPC endpoint. |
| `cursor_gap` | RPC node does not hold the ledger range the cursor points to | Reset the cursor via the SQL snippet in `docs/MAINTAINER_WORKFLOW.md §5`. |
| Lag status `never_succeeded` shortly after deploy | All of the above, or `CONTRACT_SYNC_LAG_THRESHOLD_MS` too tight | Let a sync complete, or increase the lag threshold for new deployments. |
| Sync succeeds but username stays stale | Conflict: a different user already holds the new GitHub handle | Logged as `contract_sync_username_conflict`; resolve by clearing the conflict manually. |
| `network_config_mismatch_detected` in audit log | Horizon URL and Soroban RPC URL are on different networks | Follow the [Network switching checklist](./ENVIRONMENT.md#network-switching-checklist). |

### Quick verification sequence

Run these commands against a local or staging deployment before enabling a production sync schedule:

```bash
# 1. Check RPC health
curl -s "$SOROBAN_RPC_URL" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .result.status

# 2. Trigger a dry-run sync and inspect the result
curl -s -X POST http://localhost:3000/api/contract-sync \
  -H "Authorization: Bearer $CRON_SECRET" | jq '{status, synced, errors, failureMode}'

# 3. Check lag state
curl -s http://localhost:3000/api/contract-sync \
  -H "Cookie: next-auth.session-token=$SESSION_COOKIE" | jq '{lagStatus: .lag.status, reason: .lag.reason}'

# 4. Confirm network alignment
curl -s http://localhost:3000/api/settings/network \
  -H "Cookie: next-auth.session-token=$SESSION_COOKIE" | jq '.warnings'
```

Expected output for a correctly configured deployment:

```json
// Step 2
{ "status": "ok", "synced": 42, "errors": null, "failureMode": null }

// Step 3
{ "lagStatus": "ok", "reason": "ok" }

// Step 4
[]
```

Any deviation maps to a row in the failure table above. Fix the root cause
before scheduling automated sync runs — a misconfigured scheduler that retries
every minute with an `rpc_auth_error` creates 1440 audit log entries per day
and consumes the lag-alert quota without useful signal.
