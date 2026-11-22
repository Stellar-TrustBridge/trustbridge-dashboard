# Logging and Pagination

## Structured Logging (`src/lib/logger.ts`)

TrustBridge Dashboard uses a **server-only** structured logger that emits JSON log lines. This keeps logs machine-parseable for log collectors (Datadog, Papertrail, CloudWatch, etc.) and ensures the logger never lands in client bundles.

### Importing

```ts
// Library code with no request context (e.g. background queue, soroban-register):
import { logger } from "@/lib/logger";

// Per-request context inside a route handler or server action:
import { createRequestLogger } from "@/lib/logger";
const reqLogger = createRequestLogger(crypto.randomUUID());
```

### Log levels

| Method | Destination | When to use |
|--------|------------|-------------|
| `logger.debug(msg, meta?)` | stdout | Verbose detail, only emits when `DEBUG=true` |
| `logger.info(msg, meta?)` | stdout | Normal operational events |
| `logger.warn(msg, meta?)` | stderr | Unexpected but recoverable conditions |
| `logger.error(msg, meta?)` | stderr | Failures that need on-call attention |

### JSON log shape

Every entry contains:

```json
{
  "level": "info",
  "message": "soroban_mirror_attempted",
  "context": "app",
  "timestamp": "2024-10-20T14:00:00.000Z",
  "...additional metadata fields..."
}
```

### `serializeError(error)`

Use `serializeError` to safely turn any thrown value into a plain object for embedding in a log entry:

```ts
import { logger, serializeError } from "@/lib/logger";

try {
  await riskyOperation();
} catch (err) {
  logger.error("operation_failed", { error: serializeError(err) });
}
```

`serializeError` handles:
- `Error` instances → `{ name, message, stack, cause? }`
- Non-`Error` thrown values → `{ raw: String(value) }`
- `cause` chains are serialized one level deep to bound log size.

### Child loggers

Child loggers inherit all parent fields and add their own. Each child is an independent instance — no shared mutable state:

```ts
const sorobanLogger = logger.child({
  subsystem: "soroban-register",
  registrationId: reg.id,
  contractId: process.env.SOROBAN_CONTRACT_ID,
});
sorobanLogger.info("soroban_mirror_attempted", { stellarAddress });
sorobanLogger.error("soroban_mirror_failed", { error: serializeError(err) });
```

### `createRequestLogger(requestId)`

For HTTP route handlers, create a per-request logger so every log line from a single request shares a `requestId` field:

```ts
export async function POST(request: NextRequest) {
  const reqLogger = createRequestLogger(crypto.randomUUID());
  reqLogger.info("register_start", { userId: session.user.id });
# Structured Logging and Pagination

This document describes the structured logging system and pagination features in TrustBridge Dashboard.

## Structured Logging

### Overview

The dashboard includes a structured logging system (`src/lib/logger.ts`) for debugging, monitoring, and observability. All logs are emitted as JSON to stdout, making them suitable for ingestion into centralized logging platforms (CloudWatch, Datadog, ELK, etc.).

### Log Format

```json
{
  "timestamp": "2025-01-15T10:30:45.123Z",
  "level": "info",
  "context": "api.contributors",
  "message": "incoming_request",
  "details": {
    "method": "GET",
    "pathname": "/api/contributors",
    "userAgent": "Mozilla/5.0...",
    "origin": "http://localhost:3000"
  }
}
```

**Fields:**
- `timestamp` — ISO 8601 timestamp
- `level` — Log level: `info`, `warn`, `error`, or `debug`
- `context` — Module or feature identifier (e.g., `api.contributors`, `horizon`, `database`)
- `message` — Human-readable message or event type
- `details` — Optional structured data (operation, duration, error details, etc.)

### Usage

#### Creating a logger

```typescript
import { StructuredLogger } from "@/lib/logger";

const logger = new StructuredLogger("api.contributors");
```

#### Logging events

```typescript
// Info level
logger.info("batch_recheck_started", {
  count: 42,
  initiatedBy: "user@example.com",
});

// Warn level
logger.warn("high_latency_detected", {
  endpoint: "horizon.stellar.org",
  responseTime: "2500ms",
  threshold: "2000ms",
});

// Error level
logger.error("horizon_circuit_breaker_open", {
  failureCount: 5,
  recoveryAt: "2025-01-15T10:35:45.123Z",
});

// Debug level (only logged when DEBUG=true)
logger.debug("cache_hit", {
  key: "horizon_GBRPYH...",
  age: "125ms",
});
```

#### Request logging

```typescript
import { createRequestLogger } from "@/lib/logger";

const logRequest = createRequestLogger("api.check");

export async function POST(request: NextRequest) {
  logRequest(request); // Logs incoming request
  // Handle request...
}
```

#### Response logging

```typescript
import { StructuredLogger, logResponse } from "@/lib/logger";

const logger = new StructuredLogger("api.contributors");

export async function GET() {
  const start = Date.now();
  const contributors = await getContributors();
  const duration = Date.now() - start;

  const response = NextResponse.json({ contributors });
  logResponse(logger, response, duration, { count: contributors.length });

  return response;
}
```

### Enabling debug logging

Set the `DEBUG` environment variable to enable debug-level logs:

```bash
DEBUG=true npm run dev
```

### Log aggregation

For production deployments, configure your logging platform to ingest structured JSON logs:

**CloudWatch (AWS):**

```
[ip, id, user_id, timestamp, request_id, event_type = "api", log_level, context, message, details = {}]
```

**Datadog:**

```typescript
const logger = new StructuredLogger("trustbridge.dashboard");
// Datadog automatically ingests JSON logs from stdout
```

**ELK Stack:**

```yaml
input {
  stdin {}
}

filter {
  json {
    source => "message"
  }
}

output {
  elasticsearch {
    hosts => ["localhost:9200"]
    index => "trustbridge-%{+YYYY.MM.dd}"
  }
}
```

---

## Request ID Contract

### Overview

Every API request is assigned an opaque `x-request-id` header value — a UUID v4 — that travels through the request/response lifecycle and can be surfaced in UI error messages so users can relay it to support. The utilities live in [`src/lib/request-id.ts`](../src/lib/request-id.ts).

### Generation

`generateRequestId()` produces a UUID v4 using `crypto.randomUUID()` (available in Node.js 14.17+, Edge Runtime, and all modern browsers) with a manual `crypto.getRandomValues()` fallback for older Node 18.x environments:

```typescript
import { generateRequestId } from "@/lib/request-id";

const requestId = generateRequestId();
// → "f47ac10b-58cc-4372-a567-0e02b2c3d479"
```

### Middleware propagation

Middleware should read an incoming `x-request-id` header (forwarded by a load balancer or upstream proxy) or generate a fresh one, then forward it on both the downstream request and the response:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { generateRequestId, extractRequestId } from "@/lib/request-id";

export function middleware(request: NextRequest) {
  // Honour an upstream-supplied ID, otherwise mint a new one
  const requestId = extractRequestId(request.headers) ?? generateRequestId();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Echo the ID back so clients and CDNs can correlate logs
  response.headers.set("x-request-id", requestId);
  return response;
}
```

`extractRequestId()` validates that the incoming value matches the UUID v4 format and returns `null` for absent or malformed values — preventing header injection from propagating into logs.

### Structured log correlation

Pass the request ID in the `details` field of every structured log entry so log aggregators can group all events for a single request:

```typescript
import { StructuredLogger } from "@/lib/logger";
import { extractRequestId } from "@/lib/request-id";

const logger = new StructuredLogger("api.register");

export async function POST(requ

---

## Cursor Pagination

### Overview

List endpoints (e.g. `GET /api/contributors/paginated`) use opaque, signed cursors instead of offset pagination. Cursors are produced and validated by [`src/lib/cursor-pagination.ts`](../src/lib/cursor-pagination.ts) and consumed by [`src/app/api/contributors/paginated/route.ts`](../src/app/api/contributors/paginated/route.ts).

### Cursor TTL

Every cursor embeds an issued-at timestamp and is only valid for a bounded window (the **cursor TTL**). Once the TTL elapses the cursor is considered **expired**: the server will no longer accept it, even if the underlying data has not changed. This bounds the lifetime of any snapshot a cursor points at and prevents stale cursors from being replayed indefinitely.

- A cursor is valid from the moment it is issued until `issuedAt + TTL`.
- Expiry is evaluated server-side on every request; clients cannot extend a cursor's lifetime.
- When a cursor expires, the client must restart pagination from the first page (omit the `cursor` query parameter) rather than retrying the same cursor.

### `InvalidCursor` error shape

When a cursor is malformed, tampered with, or expired, the endpoint responds with a stable error shape aligned with the rest of the API:

```json
{
  "error": "InvalidCursor",
  "message": "Cursor is invalid or has expired",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

- `error` — stable machine-readable code (`InvalidCursor`). Branch on this value, not on `message`.
- `message` — human-readable description; may change without notice.
- `requestId` — correlates with server logs (see the Request ID Contract above).

### Recovery guidance

On `InvalidCursor`:

1. **Do not retry the same cursor.** It will never become valid again.
2. Discard the cursor and restart from the first page (no `cursor` parameter).
3. If the failure persists on a freshly issued cursor, surface the `requestId` to the user and stop — this indicates a server-side problem, not a client one.

### Recommended client retry / backoff

- Retry only **transient** failures (network errors, `5xx`, `429`). Use exponential backoff with jitter (e.g. base 250 ms, factor 2, cap ~10 s) and a small bounded attempt count (e.g. 3–5).
- **Never** retry `InvalidCursor` in a loop. Treat it as a terminal signal for that cursor and restart pagination once.
- Honour `Retry-After` on `429`/`503` responses when present.
- Cap total restarts per pagination session (e.g. one restart) so a persistently failing cursor cannot cause an infinite loop.

```ts
async function fetchPage(cursor?: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`/api/contributors/paginated${cursor ? `?cursor=${cursor}` : ""}`);
    if (res.ok) return res.json();

    const body = await res.json().catch(() => ({}));
    if (body.error === "InvalidCursor") {
      // Terminal for this cursor — restart once from the first page.
      return fetchPage(undefined);
    }
    if (res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 100));
      continue;
    }
    throw new Error(body.message ?? `Request failed: ${res.status}`);
  }
  throw new Error("Pagination retry budget exhausted");
}
```
