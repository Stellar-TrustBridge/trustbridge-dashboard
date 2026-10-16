/**
 * k6 load test: treasury export + contributor reads
 *
 * Issue #517 — Wave payout window load validation.
 *
 * Scenarios
 * ─────────
 * 1. treasury_export_get   — paginated GET /api/treasury/export (maintainer session)
 * 2. treasury_export_post  — POST /api/treasury/export (maintainer session, JSON format)
 * 3. contributors_paginated — GET /api/contributors/paginated (maintainer session)
 * 4. contributors_csv      — GET /api/contributors/export/csv (API key bearer)
 * 5. cron_export           — POST /api/cron/export (CRON_SECRET bearer)
 *
 * Auth patterns
 * ─────────────
 * • Maintainer session: set TEST_SESSION_COOKIE to the raw value of the
 *   next-auth.session-token cookie obtained from a staging sign-in.
 *   Required for scenarios 1, 2, and 3.
 * • API key bearer: set TEST_API_KEY to a `tb_…` key with scope `export:read`.
 *   Required for scenario 4.
 * • CRON_SECRET bearer: set TEST_CRON_SECRET to match the server CRON_SECRET env var.
 *   Required for scenario 5.
 *
 * CSRF
 * ────
 * The CSRF middleware (assertSameOrigin) allows requests without an Origin or
 * Referer header, which is always the case for k6. No CSRF token is needed.
 *
 * Required env vars
 * ──────────────────
 * BASE_URL            – base URL of the running app (default: http://localhost:3000)
 * VUS                 – virtual users (default: 5)
 * DURATION            – test duration, e.g. 30s, 2m (default: 30s)
 * TEST_SESSION_COOKIE – next-auth.session-token value for a maintainer session
 * TEST_API_KEY        – tb_… API key with export:read scope
 * TEST_CRON_SECRET    – CRON_SECRET value configured on the server
 *
 * Optional env vars
 * ──────────────────
 * EXPORT_LIMIT        – page size for treasury export GET/POST (default: 25)
 * CONTRIBUTORS_LIMIT  – page size for contributors paginated (default: 25)
 * EXPORT_FORMAT       – "json" or "csv" for treasury export POST (default: "json")
 *
 * Usage
 * ─────
 * # Via npm script (recommended):
 * npm run test:k6:treasury
 *
 * # Directly with k6:
 * BASE_URL=http://localhost:3000 \
 *   TEST_SESSION_COOKIE="<session-token>" \
 *   TEST_API_KEY="tb_Abc123..." \
 *   TEST_CRON_SECRET="<cron-secret>" \
 *   VUS=5 \
 *   DURATION=30s \
 *   k6 run scripts/k6/treasury-export-load.js
 *
 * # Focused scenario (API-key scenario only, no session needed):
 * TEST_API_KEY="tb_Abc123..." \
 *   k6 run --env SKIP_SESSION_SCENARIOS=1 scripts/k6/treasury-export-load.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';

// ── Environment variable resolution ───────────────────────────────────────

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const VUS = __ENV.VUS ? Number(__ENV.VUS) : 5;
const DURATION = __ENV.DURATION || '30s';

const SESSION_COOKIE = __ENV.TEST_SESSION_COOKIE || '';
const API_KEY = __ENV.TEST_API_KEY || '';
const CRON_SECRET = __ENV.TEST_CRON_SECRET || '';

const EXPORT_LIMIT = __ENV.EXPORT_LIMIT ? Number(__ENV.EXPORT_LIMIT) : 25;
const CONTRIBUTORS_LIMIT = __ENV.CONTRIBUTORS_LIMIT
  ? Number(__ENV.CONTRIBUTORS_LIMIT)
  : 25;
const EXPORT_FORMAT = __ENV.EXPORT_FORMAT || 'json';

// When SKIP_SESSION_SCENARIOS is set (non-empty), skip scenarios that require
// a maintainer session and run only the API-key and cron-secret scenarios.
const SKIP_SESSION = Boolean(__ENV.SKIP_SESSION_SCENARIOS);

// ── k6 options ─────────────────────────────────────────────────────────────

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // Overall failure rate across all scenarios
    http_req_failed: ['rate<0.05'],

    // p95 latency per scenario tag — treasury export may be slow due to DB
    // aggregation; allow up to 3 s before flagging a regression.
    'http_req_duration{scenario:treasury_export_get}': ['p(95)<3000'],
    'http_req_duration{scenario:treasury_export_post}': ['p(95)<3000'],

    // Contributor reads are lighter; 1.5 s is a conservative Wave threshold.
    'http_req_duration{scenario:contributors_paginated}': ['p(95)<1500'],
    'http_req_duration{scenario:contributors_csv}': ['p(95)<1500'],

    // Cron export triggers a full DB sweep + (optional) email; allow up to 5 s.
    'http_req_duration{scenario:cron_export}': ['p(95)<5000'],

    // At least 90 % of checks should pass (allows for expected 401/403 when
    // env vars are intentionally omitted in CI smoke runs).
    checks: ['rate>0.90'],
  },
};

// ── Header builders ────────────────────────────────────────────────────────

/**
 * Headers for maintainer session authentication.
 * NextAuth uses an HttpOnly cookie; k6 passes it via the Cookie header.
 */
function sessionHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cookie': SESSION_COOKIE ? `next-auth.session-token=${SESSION_COOKIE}` : '',
  };
}

/**
 * Headers for API key bearer authentication (export:read scope).
 */
function apiKeyHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': API_KEY ? `Bearer ${API_KEY}` : '',
  };
}

/**
 * Headers for CRON_SECRET bearer authentication.
 */
function cronHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': CRON_SECRET ? `Bearer ${CRON_SECRET}` : '',
  };
}

// ── Scenario implementations ───────────────────────────────────────────────

/**
 * Scenario 1: GET /api/treasury/export (paginated, maintainer session)
 *
 * Validates p95 latency for paginated treasury export reads. Simulates the
 * maintainer dashboard triggering a read-only export over multiple pages.
 */
function scenarioTreasuryExportGet() {
  group('treasury_export_get', () => {
    const url = `${BASE_URL}/api/treasury/export?offset=0&limit=${EXPORT_LIMIT}`;
    const res = http.get(url, {
      headers: sessionHeaders(),
      tags: { scenario: 'treasury_export_get', name: 'treasury-export-get' },
      // Increase timeout for large exports
      timeout: '15s',
    });

    check(res, {
      'treasury export GET: status is 200 or 403 (no session)': (r) =>
        r.status === 200 || r.status === 403,
      'treasury export GET: not a server error': (r) => r.status < 500,
      'treasury export GET: response has body': (r) => r.body !== null && r.body.length > 0,
    });

    // When auth succeeds, validate the response structure
    if (res.status === 200) {
      let body;
      try {
        body = JSON.parse(res.body);
      } catch (_) {
        // CSV mode or streaming; skip JSON validation
        body = null;
      }
      if (body) {
        check(body, {
          'treasury export GET: has exportedAt': (b) => typeof b.exportedAt === 'string',
          'treasury export GET: has contributors array': (b) => Array.isArray(b.contributors),
          'treasury export GET: has pagination fields': (b) =>
            typeof b.offset === 'number' && typeof b.limit === 'number',
        });
      }
    }

    // 401 or 403 when session env var is missing — expected in CI smoke runs
    if (res.status === 401 || res.status === 403) {
      check(res, {
        'treasury export GET: auth error is expected (missing TEST_SESSION_COOKIE)': () =>
          !SESSION_COOKIE,
      });
    }
  });
}

/**
 * Scenario 2: POST /api/treasury/export (maintainer session)
 *
 * Exercises the treasury export POST endpoint used by the dashboard UI.
 * No Origin header is sent, so CSRF passes automatically for this non-browser client.
 * Uses allowStale: true to avoid 409 conflicts from stale-data guard during testing.
 */
function scenarioTreasuryExportPost() {
  group('treasury_export_post', () => {
    const payload = JSON.stringify({
      format: EXPORT_FORMAT,
      offset: 0,
      limit: EXPORT_LIMIT,
      allowStale: true,   // skip stale-data 409 during load tests
    });

    const res = http.post(
      `${BASE_URL}/api/treasury/export`,
      payload,
      {
        headers: sessionHeaders(),
        tags: { scenario: 'treasury_export_post', name: 'treasury-export-post' },
        timeout: '15s',
      },
    );

    check(res, {
      'treasury export POST: status is 200, 403, or 409': (r) =>
        r.status === 200 || r.status === 403 || r.status === 409,
      'treasury export POST: not a server error': (r) => r.status < 500,
    });

    // 409 is the stale-data guard firing — acceptable during testing
    if (res.status === 409) {
      let body;
      try { body = JSON.parse(res.body); } catch (_) { body = null; }
      check(body, {
        'treasury export POST: 409 has stale guard reason': (b) =>
          b !== null && typeof b.reason === 'string',
      });
    }

    if (res.status === 200 && EXPORT_FORMAT === 'json') {
      let body;
      try { body = JSON.parse(res.body); } catch (_) { body = null; }
      if (body) {
        check(body, {
          'treasury export POST: has exportedAt': (b) => typeof b.exportedAt === 'string',
          'treasury export POST: has contributors array': (b) =>
            Array.isArray(b.contributors),
        });
      }
    }

    if (res.status === 200 && EXPORT_FORMAT === 'csv') {
      check(res, {
        'treasury export POST: CSV content-type': (r) =>
          (r.headers['Content-Type'] || '').startsWith('text/csv'),
      });
    }
  });
}

/**
 * Scenario 3: GET /api/contributors/paginated (maintainer session)
 *
 * Simulates infinite-scroll contributor reads from the dashboard table.
 * Validates p95 latency for paginated reads under Wave traffic.
 */
function scenarioContributorsPaginated() {
  group('contributors_paginated', () => {
    const url = `${BASE_URL}/api/contributors/paginated?limit=${CONTRIBUTORS_LIMIT}`;
    const res = http.get(url, {
      headers: sessionHeaders(),
      tags: { scenario: 'contributors_paginated', name: 'contributors-paginated' },
      timeout: '10s',
    });

    check(res, {
      'contributors paginated: status is 200 or 403': (r) =>
        r.status === 200 || r.status === 403,
      'contributors paginated: not a server error': (r) => r.status < 500,
    });

    if (res.status === 200) {
      let body;
      try { body = JSON.parse(res.body); } catch (_) { body = null; }
      if (body) {
        check(body, {
          'contributors paginated: has contributors array': (b) =>
            Array.isArray(b.contributors),
          'contributors paginated: has hasMore flag': (b) =>
            typeof b.hasMore === 'boolean',
          'contributors paginated: has total count': (b) =>
            typeof b.total === 'number',
        });
      }
    }
  });
}

/**
 * Scenario 4: GET /api/contributors/export/csv (API key bearer)
 *
 * Tests the machine-to-machine export path that cron jobs and CI pipelines use.
 * Requires a valid tb_… API key with scope export:read.
 * Rate-limited at 60 req/min per IP — expect 429 under high VU counts.
 */
function scenarioContributorsCsv() {
  group('contributors_csv', () => {
    const res = http.get(`${BASE_URL}/api/contributors/export/csv`, {
      headers: apiKeyHeaders(),
      tags: { scenario: 'contributors_csv', name: 'contributors-csv-export' },
      timeout: '15s',
    });

    // 401 when no API key, 429 when rate limited — both are acceptable
    check(res, {
      'contributors CSV: status is 200, 401, or 429': (r) =>
        r.status === 200 || r.status === 401 || r.status === 429,
      'contributors CSV: not a server error': (r) => r.status < 500,
    });

    if (res.status === 200) {
      check(res, {
        'contributors CSV: content-type is text/csv': (r) =>
          (r.headers['Content-Type'] || '').startsWith('text/csv'),
        'contributors CSV: has content-disposition': (r) =>
          Boolean(r.headers['Content-Disposition']),
      });
    }

    if (res.status === 429) {
      check(res, {
        'contributors CSV: 429 has Retry-After header': (r) =>
          Boolean(r.headers['Retry-After']),
      });
    }

    if (res.status === 401) {
      check(res, {
        'contributors CSV: 401 is expected (missing TEST_API_KEY)': () =>
          !API_KEY,
      });
    }
  });
}

/**
 * Scenario 5: POST /api/cron/export (CRON_SECRET bearer)
 *
 * Simulates the nightly treasury CSV cron job. Rate-gated by
 * CRON_EXPORT_MIN_INTERVAL_MS on the server (default 60 s); most calls under
 * load will return 200 with status "skipped" — that is the correct behaviour.
 * No CSRF header needed (non-browser, no Origin sent).
 */
function scenarioCronExport() {
  group('cron_export', () => {
    const res = http.post(
      `${BASE_URL}/api/cron/export`,
      JSON.stringify({}),
      {
        headers: cronHeaders(),
        tags: { scenario: 'cron_export', name: 'cron-export-post' },
        timeout: '30s',
      },
    );

    // 403 when no CRON_SECRET; 200 with skipped/error/ok when rate-gated
    check(res, {
      'cron export: status is 200, 403, or 502': (r) =>
        r.status === 200 || r.status === 403 || r.status === 502,
      'cron export: not an unexpected server error': (r) =>
        r.status !== 500,
    });

    if (res.status === 200) {
      let body;
      try { body = JSON.parse(res.body); } catch (_) { body = null; }
      if (body) {
        check(body, {
          'cron export: has status field': (b) => typeof b.status === 'string',
        });
      }
    }

    if (res.status === 403) {
      check(res, {
        'cron export: 403 is expected (missing TEST_CRON_SECRET)': () =>
          !CRON_SECRET,
      });
    }
  });
}

// ── Default function ───────────────────────────────────────────────────────

/**
 * Main VU execution loop. Each iteration runs all applicable scenarios in
 * sequence with short sleeps between requests to avoid overwhelming the rate
 * limiter and to simulate realistic Wave-traffic interleaving.
 *
 * Scenarios 1–3 require TEST_SESSION_COOKIE and are skipped when
 * SKIP_SESSION_SCENARIOS is set (useful for API-key-only CI checks).
 */
export default function () {
  if (!SKIP_SESSION) {
    scenarioTreasuryExportGet();
    sleep(0.3);

    scenarioTreasuryExportPost();
    sleep(0.3);

    scenarioContributorsPaginated();
    sleep(0.3);
  }

  // API key and cron scenarios run regardless of session availability
  scenarioContributorsCsv();
  sleep(0.3);

  scenarioCronExport();
  sleep(0.5);
}
