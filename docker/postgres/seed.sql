-- Deterministic local development fixtures. Safe to re-run: all inserts use
-- ON CONFLICT DO NOTHING. Mounted into the postgres init dir; on a fresh volume
-- the guard below skips seeding because migrations have not run yet. Apply
-- after migrating with:
--   docker compose exec -T postgres psql -U trustbridge -d trustbridge_dashboard < docker/postgres/seed.sql
DO $seed$
BEGIN
  IF to_regclass('public."User"') IS NULL
     OR to_regclass('public."Registration"') IS NULL THEN
    RAISE NOTICE 'Seed skipped: Prisma tables are missing. Run migrations first, then re-apply docker/postgres/seed.sql.';
    RETURN;
  END IF;

  INSERT INTO "User" ("id", "maintainerOrgId", "githubId", "githubUsername", "name", "createdAt", "updatedAt")
  VALUES
    ('seed-user-alice', 'default', '1001', 'alice', 'Alice Seed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    ('seed-user-bob', 'default', '1002', 'bob', 'Bob Seed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  ON CONFLICT DO NOTHING;

  INSERT INTO "Registration" (
    "id", "maintainerOrgId", "userId", "stellarAddress", "funded",
    "trustlineReady", "trustlineAuthorized", "xlmBalance",
    "spendableXlmBalance", "usdcBalance", "lastCheckedAt",
    "createdAt", "updatedAt", "notes"
  )
  VALUES
    (
      'seed-reg-alice', 'default', 'seed-user-alice',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      true, true, true, '10.0000000', '8.5000000', '50.0000000',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      'Seed row: mock Horizon funded account'
    ),
    (
      'seed-reg-bob', 'default', 'seed-user-bob',
      'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      true, true, false, '0.5000000', '0.0000000', '10.0000000',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      'Seed row: mock Horizon low-balance account'
    )
  ON CONFLICT DO NOTHING;
END $seed$;
