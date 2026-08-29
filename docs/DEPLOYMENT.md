# Deployment (Vercel)

Deploy TrustBridge Dashboard to Vercel with PostgreSQL.

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md)

---

## Overview

| Component | Vercel service |
|-----------|----------------|
| Next.js app | Vercel project (auto-build) |
| PostgreSQL | Vercel Postgres, Neon, or Supabase |
| Auth | GitHub OAuth (external) |
| Stellar data | Horizon API (external) |

---

## Pre-deployment checklist

- [ ] GitHub repo pushed to GitHub
- [ ] Production PostgreSQL provisioned
- [ ] GitHub OAuth App created for production domain
- [ ] All env vars documented in [ENVIRONMENT.md](./ENVIRONMENT.md)

---

## Step 1: Import to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import `trustbridge-dashboard` repository
3. Framework preset: **Next.js** (auto-detected)
4. Build command: `npm run build` (default)
5. Output: default

---

## Step 2: Environment variables

Add in Vercel → Settings → Environment Variables:

```
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
NEXTAUTH_URL=https://your-project.vercel.app
NEXTAUTH_SECRET
GITHUB_MAINTAINER_ORG
DATABASE_URL
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org
NEXT_PUBLIC_DEFAULT_ASSET_CODE=USDC
NEXT_PUBLIC_DEFAULT_ASSET_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
NEXT_PUBLIC_MIN_XLM_BALANCE=1
```

Deploy once, then update `NEXTAUTH_URL` if using a custom domain.

---

## Step 3: Database migration

From your local machine with production `DATABASE_URL`:

```bash
DATABASE_URL="postgresql://..." npm run db:push
```

Or use Prisma Migrate for versioned migrations:

```bash
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

---

## Step 4: GitHub OAuth production app

Update or create OAuth App:

| Field | Value |
|-------|-------|
| Homepage URL | `https://your-domain.vercel.app` |
| Callback URL | `https://your-domain.vercel.app/api/auth/callback/github` |

---

## Step 5: Verify production

| Test | URL |
|------|-----|
| Landing | `/` |
| OAuth sign-in | CTA → GitHub → `/register` |
| Registration | Enter G-address, save |
| Dashboard | `/dashboard` (maintainer org member) |
| API health | `POST /api/check` with `{ "address": "G..." }` |

---

## Custom domain

1. Vercel → Domains → add domain
2. Update `NEXTAUTH_URL` to custom domain
3. Update GitHub OAuth callback URL
4. Redeploy

---

## Monitoring & limits

- **Horizon rate limits** — batch re-check queries one account per registration; large Waves may need throttling (future enhancement)
- **Vercel serverless timeout** — default 10s on Hobby; batch re-check may need pagination for 100+ contributors
- **Database connections** — use connection pooling (Neon pooler, Supabase pooler, or Prisma Accelerate)

---

## CI recommendation

Add GitHub Actions workflow:

```yaml
# .github/workflows/ci.yml (suggested)
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm run build
        env:
          DATABASE_URL: postgresql://placeholder:placeholder@localhost:5432/placeholder
          NEXTAUTH_SECRET: ci-build-secret
          GITHUB_CLIENT_ID: placeholder
          GITHUB_CLIENT_SECRET: placeholder
```

---

## Related docs

- [Setup guide](./SETUP.md)
- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)

---

## Background Worker Process

For durable background processing (such as batch rechecks across all contributors or asynchronous task runs), TrustBridge uses a durable database-backed queue (`QueueJob` table in PostgreSQL).

### Running the Worker

In production environments (or alongside Next.js on Render/Railway/Fly.io/EC2), run the dedicated worker process:

```bash
npm run worker
```

### Worker Architecture & Characteristics

1. **Durable Persistence**: Jobs are enqueued into PostgreSQL with status `pending`. Jobs survive application deployments and server restarts without loss.
2. **Atomic Claiming**: Workers atomically claim pending jobs (`UPDATE ... WHERE id = ... AND status = 'pending'`), preventing duplicate processing when multiple worker instances run in parallel.
3. **Poison Message Handling**: If a job fails or encounters an unhandled exception, it is marked as `failed` with the error message persisted in the database. The worker continues executing subsequent jobs.
4. **Graceful Shutdown**: The worker process listens for `SIGINT` and `SIGTERM` to finish processing the in-flight job before exiting cleanly.
5. **Environment Configuration**: Ensure the worker has access to `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GITHUB_MAINTAINER_ORG`, and `NEXT_PUBLIC_HORIZON_URL`.
