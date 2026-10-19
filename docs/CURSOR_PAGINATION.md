# Cursor Pagination

← Back to [README](../README.md) · See also [Logging & Pagination](./LOGGING_AND_PAGINATION.md) · [API Documentation](./API_KEYS.md)

## Overview

TrustBridge uses **cursor-based pagination** for the `/api/contributors` endpoints to provide stable, scalable navigation through large contributor lists without offset/limit race conditions.

## Why cursor pagination

**Offset/limit problems:**
- ❌ Offset 100 with concurrent inserts means you see duplicates or skip records
- ❌ `OFFSET 10000` is slow on large tables (Postgres must skip 10k rows)
- ❌ Deep links break when list changes (`/contributors?page=5` shifts meaning)

**Cursor benefits:**
- ✅ Stable: cursor always points to same record, regardless of list changes
- ✅ Fast: `WHERE id > $cursor ORDER BY id LIMIT N` uses index efficiently
- ✅ Deep-linkable: maintainer can bookmark mid-list and return later
- ✅ No duplicate or skipped records during pagination

## API contract

### Request parameters

```
GET /api/contributors/paginated?cursor=<base64>&limit=<number>
```

| Parameter | Type | Required | Default | Max | Description |
|-----------|------|----------|---------|-----|-------------|
| `cursor` | string (base64) | No | — | — | Opaque cursor from previous `nextCursor` response field |
| `limit` | number | No | 50 | 100 | Page size |

### Response format

```json
{
  "data": [
    { "id": "...", "githubUsername": "alice", ... },
    { "id": "...", "githubUsername": "bob", ... }
  ],
  "nextCursor": "Y29udHJpYnV0b3ItaWQtYm9i",
  "hasMore": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data` | array | Current page of contributor records (max `limit` items) |
| `nextCursor` | string \| null | Opaque base64 cursor to fetch next page; `null` when `hasMore=false` |
| `hasMore` | boolean | `true` if more records exist after this page; `false` at end of list |

### Example: fetch first two pages

```bash
# Page 1 (no cursor = start of list)
curl https://trustbridge.example.com/api/contributors/paginated?limit=2

{
  "data": [
    { "githubUsername": "alice", ... },
    { "githubUsername": "bob", ... }
  ],
  "nextCursor": "Y29udHJpYnV0b3ItaWQtYm9i",
  "hasMore": true
}

# Page 2 (pass nextCursor from page 1)
curl https://trustbridge.example.com/api/contributors/paginated?cursor=Y29udHJpYnV0b3ItaWQtYm9i&limit=2

{
  "data": [
    { "githubUsername": "carol", ... },
    { "githubUsername": "dave", ... }
  ],
  "nextCursor": "Y29udHJpYnV0b3ItaWQtZGF2ZQ==",
  "hasMore": false
}
```

## Cursor format

Cursors are **opaque base64-encoded strings**. Clients must:
- ✅ Treat cursors as black boxes (never decode or parse them)
- ✅ Pass `nextCursor` from response directly to next request
- ✅ Stop fetching when `hasMore=false` or `nextCursor=null`

**Internal format (for reference only):**
Cursors encode the last record's ID from the current page. The API decodes it server-side and queries `WHERE id > $decoded_cursor ORDER BY id`.

### Cursor validation

The API validates incoming cursors and rejects malformed ones:

| Input | Behavior |
|-------|----------|
| Valid base64 cursor | Decoded and used for `WHERE` clause |
| Invalid base64 | Treated as null → returns first page |
| Empty string | Treated as null → returns first page |
| Tampered cursor | Fails round-trip check → treated as null |

This ensures **broken deep links fail gracefully** (show first page) rather than crashing.

## Client integration

### React hook example

```typescript
import useSWR from 'swr';
import { useState } from 'react';

function useContributors(initialLimit = 50) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [limit] = useState(initialLimit);

  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);

  const { data, error, isLoading } = useSWR(
    `/api/contributors/paginated?${params}`,
    fetcher
  );

  const loadMore = () => {
    if (data?.nextCursor) setCursor(data.nextCursor);
  };

  return {
    contributors: data?.data ?? [],
    hasMore: data?.hasMore ?? false,
    loadMore,
    isLoading,
    error,
  };
}
```

### Infinite scroll example

```typescript
function ContributorList() {
  const { contributors, hasMore, loadMore, isLoading } = useContributors();

  return (
    <div>
      {contributors.map(c => (
        <ContributorCard key={c.id} contributor={c} />
      ))}
      {hasMore && (
        <button onClick={loadMore} disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}
```

## Deep link stability

Cursors enable **stable deep links** that preserve maintainer position in the list:

```
https://trustbridge.example.com/dashboard/contributors?cursor=Y29udHJpYnV0b3ItaWQtYWxpY2U=&limit=50
```

**Guarantees:**
- ✅ Bookmark works after list changes (new contributors added/removed)
- ✅ Cursor points to same contributor ID, not a shifting offset
- ✅ No PII in cursor (encodes internal ID, not Stellar address/email)

**Example:** Maintainer pauses review at contributor #47, bookmarks the URL, comes back next week after 10 new registrations. The cursor still shows contributors starting from #47 (now at a different offset but same ID).

## Performance

| Operation | Complexity | Index used |
|-----------|------------|------------|
| First page | O(n log n) | `PRIMARY KEY (id)` |
| Subsequent pages | O(n log n) | Same index, continues scan |
| Deep page (offset 10k) | **O(n log n)** (cursor) vs O(10k) (offset) | Index seek, not full scan |

Cursor pagination stays fast at any depth because `WHERE id > $cursor` is an index seek, not a skip-10k-rows operation.

## API and client consistency

**The cursor encode/decode helpers (`src/lib/cursor-pagination.ts`) are shared between:**
1. API routes (`src/app/api/contributors/paginated/route.ts`)
2. Client hooks (`src/lib/use-paginated-contributors.ts`)

**This guarantees:**
- ✅ Same limit bounds (min=1, max=100, default=50)
- ✅ Same cursor format (base64 of ID)
- ✅ Same validation rules (reject non-base64, enforce round-trip)

**Test coverage:** `src/lib/cursor-pagination.test.ts` includes API/client consistency tests that verify both sides agree on cursor format and limit enforcement.

## Troubleshooting

### Cursor returns empty page

**Cause:** The cursor points to a contributor that was deleted, or the ID no longer exists.

**Fix:** The API treats this as "no more records after this ID" and returns `data=[], hasMore=false`. Client should detect `hasMore=false` and stop fetching.

### Cursor is null but list is not empty

**Cause:** API returned `nextCursor=null` because you're on the last page.

**Fix:** This is expected. `hasMore=false` means the list is complete.

### Deep link shows first page instead of bookmarked position

**Cause:** Cursor was truncated, URL-encoded incorrectly, or manually tampered with.

**Fix:**
1. Verify the full cursor is in the URL (base64 can be long)
2. Ensure cursor is URL-encoded if it contains `+` or `/` (standard base64 alphabet)
3. Re-generate the deep link from the dashboard (don't hand-edit cursors)

### Cursor includes PII

**Not possible.** Cursors encode internal record IDs (UUIDs or auto-increment integers), never Stellar addresses, GitHub usernames, or emails.

Example cursor breakdown:
```
Y29udHJpYnV0b3ItaWQtYWxpY2U=  →  base64 decode  →  "contributor-id-alice"
```

The string "alice" here is an internal ID, not a GitHub username. The actual GitHub username is in the `data` array, not the cursor.

## Migration from offset/limit

**Before (offset/limit):**
```
GET /api/contributors?offset=100&limit=50
```

**After (cursor):**
```
GET /api/contributors/paginated?cursor=<from-previous-response>&limit=50
```

**Breaking changes:**
- ❌ No `offset` parameter
- ❌ No `totalCount` in response (expensive to compute on large tables)
- ✅ `nextCursor` replaces "page number" concept
- ✅ `hasMore` replaces "offset + limit < totalCount" check

**Migration path:**
1. Update client to use `/api/contributors/paginated` endpoint
2. Replace offset state with cursor state
3. Use `hasMore` to detect end of list instead of computing pages
4. (Optional) Keep `/api/contributors` (offset-based) for backward compat during migration

## Implementation files

| File | Purpose |
|------|---------|
| `src/lib/cursor-pagination.ts` | Encode/decode/validate cursors, build paginated results |
| `src/app/api/contributors/paginated/route.ts` | HTTP handler for cursor-paginated contributors API |
| `src/lib/use-paginated-contributors.ts` | React hook for client-side pagination |
| `src/lib/cursor-pagination.test.ts` | Unit tests for encode/decode, validation, API/client consistency |

## Further reading

- [Pagination best practices (Slack Engineering)](https://slack.engineering/evolving-api-pagination-at-slack/)
- [Cursor-based vs offset-based pagination (PostgreSQL Wiki)](https://wiki.postgresql.org/wiki/Pagination_Done_the_Right_Way)
- [Deep linking and bookmarkability](./LOGGING_AND_PAGINATION.md)
