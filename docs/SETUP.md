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

### Contract-backed registry mode (`REGISTRY_MODE=synced`) (#796)

When running in contract-backed mode (`REGISTRY_MODE=synced`), boot validation
(`src/lib/env-validation.ts`) fails fast unless all Soroban outbox/worker
variables are configured with real http(s) URLs (no placeholders):

```bash
REGISTRY_MODE=synced
SOROBAN_CONTRACT_ID=C...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_OUTBOX_WORKER_URL=https://worker.trustbridge.internal/outbox
SOROBAN_OUTBOX_INTERVAL_MS=15000
```

If you are developing locally without a Soroban contract or outbox worker, leave
`REGISTRY_MODE` unset (or set `REGISTRY_MODE=live`). See
[ENVIRONMENT.md — `REGISTRY_MODE`](./ENVIRONMENT.md#registry_mode).

---

## Appendix: Checklist idempotency keys (#688)

`PATCH /api/register/checklist` accepts an optional `Idempotency-Key` header
(8–128 chars, `[A-Za-z0-9_-]`) for retry-safe double submits. Keys are scoped
by org and user; the first successful response is replayed for **5 minutes**
(default; override with `CHECKLIST_IDEMPOTENCY_TTL_MS` in milliseconds) with
`X-Idempotent-Replay: true`. Requests without the header behave as before.
See [CHECKLIST_IDEMPOTENCY.md](./CHECKLIST_IDEMPOTENCY.md).

---

## Appendix: Running the outbox worker and cron locally (#779)

`npm run dev` only starts the **web** process. Wave sync and scheduled exports
run in separate processes that you must start yourself, or they will silently
stall. See [DEPLOYMENT.md — Worker process topology](./DEPLOYMENT.md#worker-process-topology-779)
for the full production topology, health probes, and failure modes.

| Process | Local command | Responsibility |
|---------|---------------|----------------|
| Web | `npm run dev` | Next.js UI + API routes |
| Outbox worker | `npm run worker:outbox` | Drains `soroban-outbox-worker.ts` queue (Wave sync) |
| Cron / export scheduler | `npm run cron:exports` | Runs scheduled CSV exports |

All three share `DATABASE_URL`. The worker and cron also read the outbox
polling and export-lock settings documented in
[ENVIRONMENT.md](./ENVIRONMENT.md). If you skip the worker, the outbox backlog
grows and Wave sync appears frozen; if you skip cron, scheduled exports never
fire. Both are detectable via the health probes in DEPLOYMENT.md.

## Registry mode (`REGISTRY_MODE`)

`REGISTRY_MODE` controls how the maintainer dashboard describes the freshness of
contributor data.  It is **optional** and defaults to `"live"`.

| Value | When to use |
|---|---|
| `"live"` *(default)* | You trigger `POST /api/contributors` manually to refresh Horizon data. |
| `"synced"` | A scheduled `syncContractToPostgres()` cron job keeps Postgres in sync automatically. |

Both modes serve reads from Postgres — the mode only changes the
`registryMode` field in `GET /api/contributors` responses.

### Local setup

No configuration needed for local development.  The default `"live"` mode
works without any background jobs.

```bash
# .env.local — only needed if you are testing the synced mode locally
REGISTRY_MODE=synced
```

### Switching modes in production

See the full migration guide in
[ARCHITECTURE.md — Registry mode](./ARCHITECTURE.md#registry-mode-registry_mode).

Short version:

```bash
# Enable synced mode (after verifying contract-sync is healthy)
vercel env add REGISTRY_MODE production   # value: synced

# Revert to live
vercel env rm REGISTRY_MODE production
```

After changing the env var, **redeploy** so all serverless instances pick up
the new value.  Validate with:

```bash
curl -s https://your-deployment.vercel.app/api/contributors \
  -H "Cookie: next-auth.session-token=<maintainer-token>" \
  | jq .registryMode
```

Expected output: `"synced"` (or `"live"` after reverting).

### Failure-open guarantee

An unrecognized `REGISTRY_MODE` value (including typos) falls back to `"live"`
without error.  Read endpoints are never broken by a bad env var.

