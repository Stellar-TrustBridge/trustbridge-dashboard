# Prisma Connection Pool Tuning & PgBouncer Guide

This guide covers configuring PostgreSQL connection pool settings for optimal performance in the TrustBridge Dashboard, especially during batch operations like CSV/JSON exports, background worker execution, and contributor rechecks.

## PgBouncer & Connection Pooling

When deploying to serverless environments (like Vercel) or when running concurrent batch operations, PostgreSQL connection limits can be quickly exhausted. Using PgBouncer in **transaction pooling mode** (e.g., Supabase pooler on port 6543, Neon connection pooling, or AWS RDS Proxy) prevents connection starvation.

### Prisma with PgBouncer Configuration

When connecting through PgBouncer in transaction mode:
1. Append `&pgbouncer=true` to your `DATABASE_URL`. This instructs Prisma Client to avoid using PostgreSQL prepared statements, which are incompatible with transaction-level pooling.
2. Set `connection_limit` appropriately for the workload (see below).
3. Set `pool_timeout` to define how long Prisma waits for a connection before timing out.

Example PgBouncer connection string:
```bash
DATABASE_URL="postgresql://trustbridge_app:password@host:6543/trustbridge?schema=public&pgbouncer=true&connection_limit=5&pool_timeout=10&idle_in_transaction_session_timeout=30000"
```

### Direct vs Pooled Connection URLs

- **`DATABASE_URL`**: Used by the runtime Next.js app and background workers. Connects through PgBouncer with `pgbouncer=true` and pool limits.
- **`DIRECT_URL` (Migrations)**: `prisma migrate` and `prisma db push` require session-level features (advisory locks, prepared statements) and must connect directly to PostgreSQL (port 5432) bypassing PgBouncer using the `trustbridge_migrator` role:

```bash
# Migrations use the direct port
DATABASE_URL="postgresql://trustbridge_migrator:password@host:5432/trustbridge?schema=public" npm run db:deploy
```

## Tenant Isolation and Database Roles

The `20260828000000_add_maintainer_org_rls` migration enables PostgreSQL row-level security on each application table. Every row has a `maintainerOrgId` value, and queries are visible only when it matches the connection setting `app.maintainer_org_id`. A missing setting matches no rows.

Use two PostgreSQL roles:

| Role | Use | RLS behavior | PgBouncer Port |
|------|-----|--------------|----------------|
| `trustbridge_app` | Runtime Prisma `DATABASE_URL` | Must set `app.maintainer_org_id`; cannot bypass RLS | 6543 (Pooled) |
| `trustbridge_migrator` | `prisma migrate deploy` only | Owns schema changes and has `BYPASSRLS` | 5432 (Direct) |

Create the roles as an existing database administrator, then grant the app role only the required schema/table privileges. Do not use a superuser or the migrator URL at runtime:

```sql
CREATE ROLE trustbridge_app LOGIN PASSWORD 'replace-me' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE trustbridge_migrator LOGIN PASSWORD 'replace-me' NOSUPERUSER BYPASSRLS;
GRANT USAGE ON SCHEMA public TO trustbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trustbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trustbridge_app;
```

Set the runtime tenant in the connection string. The value must be URL encoded, and should normally equal `GITHUB_MAINTAINER_ORG`:

```bash
DATABASE_URL="postgresql://trustbridge_app:password@host:6543/trustbridge?schema=public&pgbouncer=true&connection_limit=5&options=-c%20app.maintainer_org_id%3Dmy-org"
```

## Parameters Reference

Connection pool settings are specified in `DATABASE_URL` query parameters:

| Parameter | Default | Serverless | Worker Process | Purpose |
|-----------|---------|------------|----------------|---------|
| `connection_limit` | 10 | `1` - `5` | `5` - `10` | Max concurrent connections per instance |
| `pool_timeout` | 10 | `10` | `30` | Seconds to wait for an available connection |
| `pgbouncer` | false | `true` | `true` | Disables prepared statements for transaction pooling |
| `idle_in_transaction_session_timeout` | — | `30000` | `30000` | Milliseconds before idle transactions are killed |

## Recommended Settings by Environment

### Local Development (Docker Compose)

For local development using `docker-compose.yml`, PgBouncer is not required. Connect directly to Postgres:

```bash
DATABASE_URL="postgresql://trustbridge_app:trustbridge-app-dev-password@localhost:5432/trustbridge_dashboard?schema=public&connection_limit=5&options=-c%20app.maintainer_org_id%3Ddefault"
```

### Serverless Production (Vercel)

Each serverless function instance maintains its own small Prisma connection pool. Keep `connection_limit` small so concurrent lambdas don't overwhelm Postgres/PgBouncer:

```bash
DATABASE_URL="postgresql://trustbridge_app:password@host:6543/trustbridge?schema=public&pgbouncer=true&connection_limit=1&pool_timeout=10"
```

### Long-Running Background Worker Process (`npm run worker`)

Long-running workers handle sequential or bounded concurrent jobs. A slightly larger pool with longer timeout prevents queue stalling:

```bash
DATABASE_URL="postgresql://trustbridge_app:password@host:6543/trustbridge?schema=public&pgbouncer=true&connection_limit=5&pool_timeout=30"
```

## Troubleshooting

### Error: "Timed out acquiring a connection from the pool"

**Cause:** Pool exhausted or queries running too long.

**Fix:**
1. Increase `connection_limit` or `pool_timeout`
2. Ensure queries are indexed and transactions are committed promptly
3. Enable PgBouncer transaction pooling if deploying to serverless

### Error: "prepared statement does not exist" or "cannot run inside a transaction"

**Cause:** Prisma is sending prepared statements through PgBouncer in transaction pooling mode.

**Fix:** Add `?pgbouncer=true` to `DATABASE_URL`.

### Idle Connections Accumulating

**Fix:** Use `idle_in_transaction_session_timeout=30000` to automatically terminate stuck transactions.
