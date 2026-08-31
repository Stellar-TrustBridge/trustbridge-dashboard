# Prisma Connection Pool Tuning

This guide covers configuring PostgreSQL connection pool settings for optimal performance in the TrustBridge Dashboard, especially during batch operations like CSV/JSON exports and contributor rechecks.

## Tenant isolation and database roles

The `20260828000000_add_maintainer_org_rls` migration enables PostgreSQL row-level
security on each application table. Every row has a `maintainerOrgId` value, and
queries are visible only when it matches the connection setting
`app.maintainer_org_id`. A missing setting matches no rows.

Use two PostgreSQL roles:

| Role | Use | RLS behavior |
|------|-----|--------------|
| `trustbridge_app` | Runtime Prisma `DATABASE_URL` | Must set `app.maintainer_org_id`; cannot bypass RLS |
| `trustbridge_migrator` | `prisma migrate deploy` only | Owns schema changes and has `BYPASSRLS` |

Create the roles as an existing database administrator, then grant the app role
only the required schema/table privileges. Do not use a superuser or the
migrator URL at runtime:

```sql
CREATE ROLE trustbridge_app LOGIN PASSWORD 'replace-me' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE trustbridge_migrator LOGIN PASSWORD 'replace-me' NOSUPERUSER BYPASSRLS;
GRANT USAGE ON SCHEMA public TO trustbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trustbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trustbridge_app;
```

Set the runtime tenant in the connection string. The value must be URL encoded,
and should normally equal `GITHUB_MAINTAINER_ORG`:

```bash
DATABASE_URL="postgresql://trustbridge_app:password@host:5432/trustbridge?schema=public&options=-c%20app.maintainer_org_id%3Dmy-org"
```

Run migrations with the separate migrator URL:

```bash
DATABASE_URL="postgresql://trustbridge_migrator:password@host:5432/trustbridge" npm run db:deploy
```

Existing rows are assigned to `default` by the migration. Before enabling a real
tenant value, backfill `maintainerOrgId` for existing data using the migrator
role. CI currently runs unit tests without PostgreSQL; SQL/RLS behavior must be
verified against a PostgreSQL instance using the two roles above, not a
superuser-only test.

## Overview

Prisma manages database connections through a connection pool. The pool size, connection timeout, and idle timeout affect performance under load:

- **Too small** — requests queue, increasing latency for concurrent operations (batch recheck, exports)
- **Too large** — wastes memory and database resources
- **Optimized** — fast response times, efficient resource use

## Configuration

Connection pool settings are specified in the `DATABASE_URL` as query parameters:

```bash
postgresql://user:password@host:5432/dbname?schema=public&pool_timeout=10&connection_limit=5&idle_in_transaction_session_timeout=30000
```

### Parameters

| Parameter | Default | Example | Purpose |
|-----------|---------|---------|---------|
| `connection_limit` | 10 | `5` or `20` | Max concurrent connections to database |
| `pool_timeout` | 10 | `10` or `30` | Seconds to wait for a free connection before timeout |
| `idle_in_transaction_session_timeout` | — | `30000` | Milliseconds for idle transaction timeout (optional) |

## Recommended Settings

### Development (SQLite/Local PostgreSQL)

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/trustbridge?schema=public&connection_limit=5"
```

### Staging (Moderate Load)

```bash
DATABASE_URL="postgresql://user:password@host:5432/trustbridge?schema=public&connection_limit=10&pool_timeout=15"
```

### Production (High Availability)

```bash
DATABASE_URL="postgresql://user:password@host:5432/trustbridge?schema=public&connection_limit=20&pool_timeout=30&idle_in_transaction_session_timeout=30000"
```

## Batch Operations & Pool Size

### CSV/JSON Export

Contributors table exports iterate through all registrations. Pool exhaustion occurs when:
- Many concurrent export requests
- Long-running queries holding connections
- Default pool size too small for concurrency

**Recommendation:** Set `connection_limit=20+` for production with concurrent exports.

### Batch Contributor Recheck

Rechecks call Horizon for each contributor and update the database. With 100+ contributors:
- Sequential recheck: 1 connection per request
- Concurrent recheck: multiple connections simultaneously

**Recommendation:** Use `Promise.all()` with pooling; ensure `connection_limit ≥ 10`.

## Monitoring

### Verify Configuration

```bash
# Test connection with current pool settings
psql "postgresql://user:password@host:5432/trustbridge?schema=public&connection_limit=10" -c "SELECT 1;"
```

### Check Current Connections

```sql
-- Connect to your database and run:
SELECT datname, count(*) as connections
FROM pg_stat_activity
GROUP BY datname
ORDER BY connections DESC;

-- View specific connection limits
SHOW max_connections;
```

### Monitor in Application

Prisma logs connection events in debug mode:

```bash
DEBUG=* npm run dev
```

## Best Practices

1. **Start conservative** — Use `connection_limit=5` locally, increase if you see timeouts
2. **Match expected concurrency** — Number of concurrent requests in your heaviest operation
3. **Set pool_timeout reasonably** — Long timeout (30s) for batch jobs, shorter (10s) for user-facing requests
4. **Test under load** — Run batch operations with `ab` or similar to validate pool size
5. **Monitor in production** — Periodically check connection count and adjust as needed

## Troubleshooting

### Error: "Timed out acquiring a connection from the pool"

**Cause:** Pool exhausted or queries running too long.

**Fix:**
1. Increase `connection_limit`
2. Increase `pool_timeout`
3. Optimize slow queries (check query plans)
4. Reduce concurrent requests

### Error: "FATAL: too many connections"

**Cause:** Connection limit on database server exceeded.

**Fix:**
1. Reduce `connection_limit` in Prisma
2. Ask database provider to increase server-level `max_connections`
3. Implement connection pooling middleware (e.g., PgBouncer)

### Idle Connections Accumulating

**Cause:** Connections left idle after queries complete.

**Fix:**
1. Prisma automatically closes idle connections; no manual action needed
2. For persistent issues, reduce `connection_limit` or use `idle_in_transaction_session_timeout`

## Contributor Search Indexes & Performance Tuning

To prevent sequential scans (`seq-scan`) during contributor search and filtering as Wave data grows, the following indexes are configured in `prisma/schema.prisma`:

- `User(githubUsername)`: Indexed for fast username filtering and exact/prefix searches.
- `Registration(stellarAddress)`: Indexed for quick address lookup and collision detection.
- `Registration(updatedAt)`: Indexed for sorting and paginated timeline queries.
- `RegistrationConflict(attemptedAddress, createdAt)`: Indexed for maintainer collision audit queries.

Ensure `prisma migrate deploy` is executed to apply migration `20260829120000_contributor_search_indexes`.

## Related Files

- `prisma/schema.prisma` — Prisma schema (models, indexes)
- `src/lib/registrations.ts` — Batch export/recheck queries
- `src/lib/csv.ts` — CSV generation helpers
- `src/lib/prisma.ts` — Prisma client instantiation
