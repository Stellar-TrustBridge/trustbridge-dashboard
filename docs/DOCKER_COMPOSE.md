# Docker Compose local Wave stack

The root `docker-compose.yml` runs the full local stack: PostgreSQL 16, Adminer, a WireMock **mock Horizon**, and the Next.js **web** app built from the root `Dockerfile`. It is the recommended way to rehearse a Wave offline with deterministic contributor fixtures.

- Back to [docs/README.md](./README.md) · [Setup](./SETUP.md) · [Environment variables](./ENVIRONMENT.md)

## Services and URLs

| Service | Container | Host URL | Purpose |
|---|---|---|---|
| `web` | `trustbridge-web` | http://localhost:3000 | Next.js app (production build) |
| `postgres` | `trustbridge-postgres` | `localhost:5432` | Database + init roles + seed fixtures |
| `postgres-admin` | `trustbridge-adminer` | http://localhost:8080 | Adminer UI |
| `horizon-mock` | `trustbridge-dashboard-mock-horizon` | http://localhost:8089 | WireMock Horizon stubs, admin at `/__admin/mappings` |

Mock mappings are mounted from `mock/horizon/mappings` into WireMock. Seed accounts use the same addresses as those mappings, for example `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF` (funded) and `GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC` (low balance).

## Prerequisites

- Docker 20.10+ and Docker Compose v2.24+ (for optional `env_file` entries)
- No local Node.js required to run the containers; Node 18.17+ is still needed for host-side `npm run dev`

## Copy-paste quickstart

```bash
# 1. Build and start postgres, adminer, mock Horizon and web
docker compose up -d --build

# 2. Apply the Prisma schema as the local migration/admin role
docker compose exec -e DATABASE_URL="postgresql://trustbridge:trustbridge-dev-password@postgres:5432/trustbridge_dashboard?schema=public" web npx prisma migrate deploy

# 3. Load deterministic seed data (works on a fresh or an existing volume)
docker compose exec -T postgres psql -U trustbridge -d trustbridge_dashboard < docker/postgres/seed.sql

# 4. Verify
docker compose ps
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:8089/__admin/health
```

Open:

- Dashboard: http://localhost:3000
- Adminer: http://localhost:8080 (server `postgres`, user `trustbridge`, password `trustbridge-dev-password`, database `trustbridge_dashboard`)
- WireMock admin: http://localhost:8089/__admin/mappings

To stop while keeping data: `docker compose stop`. To remove containers but keep the volume: `docker compose down`. To delete all local data: `docker compose down -v`.

## Environment and mock Horizon

The `web` service uses defaults in `docker-compose.yml`:

| Variable | Compose value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://trustbridge_app:trustbridge-app-dev-password@postgres:5432/trustbridge_dashboard?...` | Restricted runtime role; `options=-c%20app.maintainer_org_id%3Ddefault` satisfies RLS |
| `NEXTAUTH_URL` | `http://localhost:3000` | Override for a different public host |
| `NEXT_PUBLIC_HORIZON_URL` | `http://localhost:8089` | Browser calls the host-published WireMock port |
| `NEXT_PUBLIC_DEFAULT_ASSET_CODE` | `USDC` | Must match the Action runner defaults |
| `NEXT_PUBLIC_DEFAULT_ASSET_ISSUER` | `GA5ZSEJ...K4KZVN` | Same issuer as `mock/horizon/mappings` |
| `NEXT_PUBLIC_MIN_XLM_BALANCE` / `NEXT_PUBLIC_BASE_RESERVE_XLM` | `1.5` / `0.5` | Readiness thresholds |

`NEXT_PUBLIC_*` values are baked into the browser bundle at **build** time. The root `Dockerfile` accepts them as build args (wired in `docker-compose.yml`); changing only the runtime `environment:` value will not update the client bundle — rebuild with `docker compose up -d --build`. Server-side code reads the runtime environment.

Optional overrides can be placed in `.env.local` at the repo root; Compose loads it via the optional `env_file` entry. Values in `environment:` take precedence, so edit the compose defaults (or add a Compose override file) when changing `DATABASE_URL`, `NEXTAUTH_URL` or `NEXT_PUBLIC_*`. Never commit `.env.local`.

For host-side development against the same mock, use:

```bash
NEXT_PUBLIC_HORIZON_URL=http://localhost:8089 npm run dev
```

Container-to-container server calls would use `http://horizon-mock:8080`, but the bundled browser default is the host-published `http://localhost:8089`.

## Seed data

`docker/postgres/seed.sql` inserts two users and two registrations with fixed IDs, deterministic timestamps, and mock Horizon addresses. It is idempotent (`ON CONFLICT DO NOTHING`).

- On a **fresh** volume, Postgres runs `init-roles.sql` then `seed.sql` before Prisma migrations. Because the tables do not exist yet, the seed guard logs a notice and skips; run steps 2 and 3 of the quickstart.
- On an **existing** volume (migrations already applied), the mounted init scripts do not re-run. Apply the seed explicitly with the `psql` command in step 3, or from inside the container:

```bash
docker compose exec postgres psql -U trustbridge -d trustbridge_dashboard -f /docker-entrypoint-initdb.d/20-seed.sql
```

Reset to an empty database with `docker compose down -v` and repeat the quickstart.

## Roles and RLS

`docker/postgres/init-roles.sql` creates the restricted `trustbridge_app` runtime role (used by `web`) and runs **only when the Postgres volume is created**. The `trustbridge` role is the local admin/migration role and bypasses RLS; do not use it as the application connection. All seeded rows use `maintainerOrgId = 'default'`. See [ARCHITECTURE.md](./ARCHITECTURE.md#postgresql-tenant-isolation).

## Troubleshooting

### Port 5432 already in use

Another local Postgres is listening. Stop it, or change the host-side mapping in `docker-compose.yml` (for example `"5433:5432"`) and update any host-side `DATABASE_URL`. The `web` container still uses `postgres:5432` on the Compose network.

### Port 3000 already in use

A host-side `npm run dev` or another app occupies the port. Stop it or remap the host side (`"3100:3000"`) and set `NEXTAUTH_URL=http://localhost:3100` plus a rebuild for `NEXT_PUBLIC_*` values. Check with `docker compose ps` and `lsof -i :3000`.

### Port 8089 already in use

Another WireMock/ Horizon mock is running (often from `docker compose -f mock/horizon/docker-compose.yml up`). Stop that stack or change the host mapping, and rebuild `web` with the matching `NEXT_PUBLIC_HORIZON_URL` build arg. The standalone mock compose file and this stack should not run simultaneously.

### Stale volumes / schema drift

Init scripts and the seed skip when the volume already exists. If roles, tables or fixtures look wrong:

```bash
docker compose down -v
docker compose up -d --build
# then repeat migration + seed from the quickstart
```

This deletes all local database data.

### `.env.local` and `env_file` mistakes

- `.env.local` is optional; a missing file is fine because `environment:` supplies defaults. A malformed line or a stale absolute `DATABASE_URL` in that file will break `web` — check `docker compose config` and `docker compose logs web`.
- `environment:` wins over `env_file`. Setting a conflicting `DATABASE_URL` in Compose means the `.env.local` value is ignored.
- The file is copied to the app at container start, not into the image. Never put secrets in build args or commit it.
- If `web` exits with `Environment variable not found`, confirm the URL is set and restart `docker compose up -d web`.

### Seed says "Seed skipped"

That means Prisma tables are missing. Run `npx prisma migrate deploy` (step 2) **before** applying the seed. On a fresh volume the init-time seed always skips by design.

### Mock Horizon returns 404 for a seeded address

Check `curl http://localhost:8089/__admin/mappings`, confirm `horizon-mock` is healthy, and make sure the address is one of the mappings in `mock/horizon/mappings` (not a mainnet address). Rebuild `web` after changing public Horizon env vars.

## Production note

These credentials and mocks are development-only. [DEPLOYMENT.md](./DEPLOYMENT.md) covers managed databases, pooling, and secrets for production.
