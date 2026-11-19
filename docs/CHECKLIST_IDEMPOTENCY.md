# Checklist PATCH idempotency (#688)

`PATCH /api/register/checklist` accepts an optional `Idempotency-Key` header so
double-clicks and network retries produce one logical update.

## Usage

```http
PATCH /api/register/checklist
Idempotency-Key: 7f3a9c2e-4b1d-4a55-9f0e-2c8b6d1a7e30
Content-Type: application/json

{"addressRegistered": true}
```

- Keys must be **8–128 characters** matching `[A-Za-z0-9_-]` (UUIDs and hashes
  work). A present-but-invalid key returns `400` with an `error` message.
- Requests without the header keep the previous behavior exactly: no replay,
  no extra headers.

## Cache key and TTL

The key is `checklist:idem:<orgId>:<userId>:<Idempotency-Key>` (built with
`buildCacheKey`, with org/user escaped). `orgId` is the session's active
`maintainerOrgId` (fallback `"default"`), so keys are org- and user-scoped.

The first successful response is stored in `checklistIdempotencyCache`
(`src/lib/cache.ts`) with its exact JSON body and `200` status. Duplicate
submits within the TTL return that same body with:

```
X-Idempotent-Replay: true
Idempotency-Key: <the supplied key>
Cache-Control: no-store, no-cache, must-revalidate
```

The TTL is **5 minutes** by default and can be overridden with
`CHECKLIST_IDEMPOTENCY_TTL_MS` (positive integer milliseconds). The TTL is
read at module load, so restart the process after changing it.

## Caveats

- Replays are scoped to one Node.js process (the cache is in-memory). In a
  multi-replica deployment, simultaneous retries can land on different
  replicas; each still merges into the same persisted checklist state.
- CSRF and session checks run **before** any cache lookup; a replay never
  bypasses authentication.
- A given key replays the first response even if the body differs on retry —
  generate a new key for a genuinely new update.
