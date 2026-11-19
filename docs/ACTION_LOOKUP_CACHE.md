# Action lookup cache scoping (#686)

`GET /api/actions/lookup` keeps a short-lived in-process cache of Horizon
readiness results in `verificationCache` (`src/lib/cache.ts`). The TTL is fixed
at **30 seconds** (`ACTION_LOOKUP_CACHE_TTL_MS` in `src/lib/action-lookup.ts`)
and is also emitted as `Cache-Control: public, max-age=30,
stale-while-revalidate=30`. Rate limiting (60 req/min) and public CORS headers
are unchanged.

## Key composition

`buildActionLookupCacheKey()` in `src/lib/action-lookup.ts` builds keys as:

```
action-lookup:<orgId>:<network>:<address>:<assetCode>:<assetIssuer>
```

- `orgId` — validated `?org=` query parameter when present and allowed;
  otherwise `GITHUB_MAINTAINER_ORG` (fallback `"default"`).
- `network` — normalized resolved Horizon **and** Soroban RPC URLs
  (`normalizeActionLookupNetwork()` with `resolveHorizonUrl()` /
  `resolveSorobanRpcUrl()` from `src/lib/network-config.ts`). Protocol, host
  (with explicit port) and path are significant; query strings, hashes and
  trailing slashes are ignored. Distinct custom endpoints therefore never
  share a "custom" bucket.
- `address`, `assetCode`, `assetIssuer` — the existing lookup inputs.

Every component is escaped with `encodeURIComponent` (plus escaping of its few
unescaped punctuation characters), so `:` / `|` / `/` inside a value cannot
spoof a separator and collide with another scope. Empty components are
rejected with a stable error.

## Operator notes

- Because org and network precede address/asset in the key, org A cannot read
  org B's cached result even for the same address.
- The cache is **per Node.js process**; multiple replicas each keep their own
  entries. The 30 s TTL bounds staleness.
- Changing `NEXT_PUBLIC_HORIZON_URL`, `SOROBAN_RPC_URL`, or the maintainer org
  configuration changes the key space; no manual invalidation is needed.
