# Environment Variables

Complete reference for all configuration used by TrustBridge Dashboard.

← Back to [README](../README.md) · See also [Setup guide](./SETUP.md) · [Deployment](./DEPLOYMENT.md)

Copy `.env.example` to `.env.local` (development) or configure in your Vercel project settings (production).

---

## Required variables

### `GITHUB_CLIENT_ID`

GitHub OAuth App client ID.

- **Where:** [GitHub Developer Settings](https://github.com/settings/developers)
- **Used by:** NextAuth.js GitHub provider

### `GITHUB_CLIENT_SECRET`

GitHub OAuth App client secret.

- **Server-only** — never expose to the browser
- **Used by:** NextAuth.js token exchange

### `NEXTAUTH_URL`

Canonical URL of the deployment.

| Environment | Value |
|-------------|-------|
| Local | `http://localhost:3000` |
| Production | `https://your-domain.vercel.app` |

Used for OAuth callback generation.

### `NEXTAUTH_SECRET`

Random string for JWT/session encryption.

Generate:

```bash
openssl rand -base64 32
```

**Required in production.** Missing value causes auth failures.

### `GITHUB_MAINTAINER_ORG`

GitHub organization **slug** (login name) whose members can access `/dashboard`.

Example: if your org URL is `https://github.com/stellar`, set `GITHUB_MAINTAINER_ORG=stellar`.

- Checked via GitHub API `GET /user/orgs` after sign-in
- Non-members can still use `/register`

### `DATABASE_URL`

PostgreSQL connection string.

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

Providers: local Postgres, Neon, Supabase, Vercel Postgres, Railway, etc.

### `TOKEN_ENCRYPTION_KEY`

Base64-encoded 32-byte key used to encrypt GitHub access tokens at rest (AES-256-GCM) before they are written to `User.accessToken`. See [`src/lib/token-crypto.ts`](../src/lib/token-crypto.ts).

Generate:

```bash
openssl rand -base64 32
```

**Required.** If unset, invalid, or not exactly 32 bytes after base64 decoding, sign-in fails closed — no access token is stored (rather than falling back to plaintext) and a `token_encryption_skipped` row is written to `TokenAuditLog`.

---

## Stellar / Horizon (public)

> **These values must match [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action).**
> See [Alignment with trustbridge-action](#alignment-with-trustbridge-action) below.

These are prefixed with `NEXT_PUBLIC_` and available in the browser.

### `NEXT_PUBLIC_HORIZON_URL`

Horizon API base URL.

| Network | URL |
|---------|-----|
| Mainnet | `https://horizon.stellar.org` |
| Testnet | `https://horizon-testnet.stellar.org` |

Must match the network your contributors use.

> **Network consistency:** `NEXT_PUBLIC_HORIZON_URL` and `SOROBAN_RPC_URL` (below) should point at the **same** Stellar network. The project's own defaults do not — Horizon defaults to mainnet while `SOROBAN_RPC_URL` defaults to testnet — so a maintainer who only sets one of the two can end up validating contributor funding against a different network than the one Soroban events are read from. The dashboard detects this: `GET /api/settings/network` (maintainer-only) and the "Network configuration" panel on `/dashboard` compare the resolved networks and show a warning banner when they mismatch, and a `network_config_mismatch_detected` entry is written to the audit log (visible via `GET /api/audit`) so the misconfiguration has a durable record. See [`src/lib/network-config.ts`](../src/lib/network-config.ts).

### `NEXT_PUBLIC_DEFAULT_ASSET_CODE`

Asset code for trustline checks. Default: `USDC`

### `NEXT_PUBLIC_DEFAULT_ASSET_ISSUER`

Asset issuer public key. Default: Circle USDC on Stellar mainnet:

```
GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```

Change both code and issuer together for testnet or custom assets.

### `NEXT_PUBLIC_MIN_XLM_BALANCE`

Minimum **spendable** XLM balance for **Ready** status (string parsed as float). Default: `1.5`

Accounts below this threshold show **Low Reserve** even with a valid trustline. Compared against the spendable balance (raw balance minus reserve and liabilities), not the raw `xlm_balance`.

### `NEXT_PUBLIC_BASE_RESERVE_XLM`

Stellar network base reserve, in XLM, used to compute each account's minimum reserve (string parsed as float). Default: `0.5`

Every Stellar account locks up `baseReserve * (2 + subentry_count + num_sponsoring − num_sponsored)` XLM that cannot be spent. This value rarely changes on mainnet; override only for custom networks or if the protocol-wide base reserve changes. See [Architecture — Readiness rules](./ARCHITECTURE.md#readiness-rules).

---

## Alignment with trustbridge-action

The dashboard and [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action) answer the same question — *is this contributor ready to be paid?* — from **two independently configured environments**. The dashboard reads `NEXT_PUBLIC_*` variables; the Action reads workflow inputs declared in its `action.yml`. Nothing links them at runtime.

When they drift, the failure is quiet and lands on the contributor: the dashboard shows a green **Ready** badge, the contributor closes the tab, and the workflow that actually gates their payout rejects them (or the reverse — they fix a problem the dashboard never reported).

### The contract

These four values are mirrored in [`ACTION_DEFAULTS`](../src/lib/constants.ts) and must stay equal to the Action's defaults:

| Dashboard variable | Action input (`action.yml`) | Shared default |
| --- | --- | --- |
| `NEXT_PUBLIC_HORIZON_URL` | `horizon_url` | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_DEFAULT_ASSET_CODE` | `asset_code` | `USDC` |
| `NEXT_PUBLIC_DEFAULT_ASSET_ISSUER` | `asset_issuer` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| `NEXT_PUBLIC_MIN_XLM_BALANCE` | `min_xlm_reserve` | `1.5` |

**The chosen issuer** is Circle's USDC issuing account on the Stellar **public network (mainnet)**. It is the issuer the Action ships with, and the one contributors are told to trust in the generated outreach templates. Verify any replacement with `StrKey.isValidEd25519PublicKey` before committing it — see the note on checksums below.

`min_xlm_reserve` and `NEXT_PUBLIC_MIN_XLM_BALANCE` are not *quite* the same measurement: the Action compares the account's native XLM balance, while the dashboard compares the **spendable** balance (raw balance minus reserve and liabilities). The dashboard is therefore the stricter of the two at equal thresholds, which is the safe direction. Keeping the numbers equal keeps the two verdicts as close as the different measurements allow.

### How drift is detected

[`checkActionAlignment()`](../src/lib/network-config.ts) compares the *resolved* environment against `ACTION_DEFAULTS` on every call to `getNetworkConfig()`. Its findings are attached to the `actionAlignment` field of `GET /api/settings/network` (maintainer-only) and merged into the same `warnings` list the **Network configuration** panel on `/dashboard` already renders.

It reports rather than fails, because a deliberate testnet or custom-asset deployment is legitimate and only an operator can tell the difference between that and a mistake. Two cases are worth calling out:

- **Invalid issuer.** An issuer that fails StrKey checksum validation is flagged as *invalid*, not merely different. A malformed G-address cannot be a real account on any network, so no trustline check against it can ever succeed. This is not hypothetical: the issuer this project shipped before [#119](https://github.com/Stellar-TrustBridge/trustbridge-dashboard/issues/119) had the right length, prefix, and alphabet, and failed the checksum — a regex-shaped validation would have waved it through.
- **A minimum balance *below* the Action's floor** is flagged; a value *above* it is not. Only the low side produces "ready here, rejected there". A stricter dashboard is conservative, not dangerous.

### Changing the defaults

Change the Action first, then mirror it here in the same wave:

1. Update the input default in `trustbridge-action/action.yml`.
2. Update `ACTION_DEFAULTS` in [`src/lib/constants.ts`](../src/lib/constants.ts).
3. Update the Zod defaults in [`src/lib/env-validation.ts`](../src/lib/env-validation.ts), `.env.example`, and the table above.
4. Run `npm test -- network`. The "bare environment" test in `src/lib/network-config.test.ts` fails if the shipped defaults drift from `ACTION_DEFAULTS`.

Deployments that override any of these in their environment keep their override — nothing here silently switches a running production deployment onto a different asset or network.

---

## Optional variables

### `REGISTRY_MODE`

Reported by the contributor REST endpoints (`/api/contributors`, `/api/contributors/paginated`) as `registryMode` in their response body, via `src/lib/registry-mode.ts`.

| Value | Meaning |
|-------|---------|
| `live` (default) | Reads reflect whatever is currently persisted; maintainers are expected to trigger a Horizon recheck to refresh it. |
| `synced` | Signals that a scheduled contract-to-Postgres sync job (see `CONTRACT_SYNC_MIN_INTERVAL_MS` above) is responsible for keeping registrations fresh. |

Reads are identical in both modes — Postgres is always the source of truth. An unset or unrecognized value falls back to `live` rather than failing.

### `GITHUB_MAINTAINER_TEAM`

GitHub team **slug** within `GITHUB_MAINTAINER_ORG`. When set, a user must belong to both the org **and** this team to be treated as a maintainer.

Example: if the team URL is `https://github.com/orgs/stellar/teams/dashboard-maintainers`, set `GITHUB_MAINTAINER_TEAM=dashboard-maintainers`.

- Checked via GitHub API `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` after the org check passes
- **Unset by default** — the org-only check runs exactly as before, so existing deployments are unaffected
- A user who passes the org check but fails the team check is denied and an audit log entry (`maintainer_access_denied_team`) is recorded, visible via `/api/audit`
- A GitHub API error or rate limit on either check fails closed (`isMaintainer = false`) rather than blocking sign-in

### `CHECK_CACHE_TTL_MS`

Time-to-live, in milliseconds, for entries in the `/api/check` **KV response cache**.

| Value | Behaviour |
|-------|-----------|
| Unset / invalid | Falls back to **120 000 ms (2 minutes)** |
| Any positive integer | Cache entries expire after this many ms |

**How it works:**

`POST /api/check` maintains a dedicated in-process KV cache (`checkCache` in [`src/lib/cache.ts`](../src/lib/cache.ts)) keyed by `check:<address>:<assetCode>:<assetIssuer>`. On a cache hit the route returns the stored result without making a Horizon API call.

- **Transient errors are never cached.** If `checkStellarAddress` returns an error that includes `"temporarily unavailable"` or `"Horizon error:"`, the result is not written to the cache so the next request retries Horizon.
- **Cache bypass:** callers can force a fresh Horizon check by sending the `X-Cache-Bypass: 1` request header or the `?cache_bypass=1` query parameter. When bypass is active the route also passes `useCache: false` into `checkStellarAddress`, skipping the internal `verificationCache` in `horizon.ts` as well.
- **Independence from verificationCache:** `checkCache` and `verificationCache` (used inside `horizon.ts`) are separate `CacheStore` instances with independent TTLs. This lets the route-level and library-level caches be invalidated separately — useful when a maintainer batch-rechecks addresses.

Example — aggressive caching for a read-heavy deployment:

```bash
CHECK_CACHE_TTL_MS=300000  # 5 minutes
```

Example — effectively disable the route cache (still benefits from horizon.ts internal cache):

```bash
CHECK_CACHE_TTL_MS=1  # 1 ms ≈ no caching
```

---

### `TRUSTBRIDGE_ACTION_SECRET`

Shared secret used to verify the authenticity of webhook payloads received from the TrustBridge GitHub Action.

- **Server-only** — never expose to the browser
- **Used by:** Webhook verification at `POST /api/webhooks/trustbridge-action`
- **Recommended in production.** If unset, signature verification fails and incoming webhooks are rejected with a 401 status.
- Generate: `openssl rand -base64 32`

### `SOROBAN_SECRET_KEY`

Secret key for the Soroban fee-payer account used to sign write-through transactions. Required for the `mirrorRegistrationToSoroban()` function to submit transactions to the Soroban contract.

- **Server-only** — never expose to the browser
- **Required for write-through:** If unset, the write-through is skipped with a logged error (registration still succeeds)
- **Security:** The key is used to sign transactions but never stored in the database or logs
- Generate: Use an existing Stellar secret key or generate a new one for the fee-payer account

### `SOROBAN_CONTRACT_ID`

Soroban contract ID the maintainer dashboard's **Soroban event timeline** panel reads events for. Registrations are not yet mirrored to this contract — see the write-through design note below.

When unset, registrations are stored in PostgreSQL only and the event timeline panel renders an empty state explaining that configuration is missing. See [Architecture — Soroban register write-through](./ARCHITECTURE.md#soroban-register-write-through) for the read-vs-write-through breakdown.

### `SOROBAN_RPC_URL`

Soroban RPC endpoint used to fetch contract events for the timeline panel. Defaults to `https://soroban-testnet.stellar.org` when unset.

| Network | URL |
|---------|-----|
| Mainnet | `https://mainnet.sorobanrpc.com` |
| Testnet | `https://soroban-testnet.stellar.org` |

**Keep this on the same network as `NEXT_PUBLIC_HORIZON_URL` above.** The default here is testnet while the default Horizon URL is mainnet — see the network consistency note above and [Architecture — network hardening](./ARCHITECTURE.md#network-hardening) for how the mismatch is surfaced.

### `CRON_SECRET`

Bearer token that authorizes a scheduler (e.g. Vercel Cron) to trigger `POST /api/contract-sync` without a maintainer session. Send as `Authorization: Bearer $CRON_SECRET`.

- **Optional.** With it unset, only maintainer sessions can trigger a sync — the endpoint never falls back to an open/unauthenticated trigger.
- Generate the same way as `NEXTAUTH_SECRET`: `openssl rand -base64 32`

### `NEXT_PUBLIC_POSTHOG_API_KEY`

PostHog project API key for product analytics. When set, the dashboard tracks key events like registration completions, rechecks, and CSV exports.

- **Optional.** When unset, analytics events are silently ignored (no-op) or logged to console in development.
- **Security:** This is a public key (prefixed with `NEXT_PUBLIC_`) — PostHog project API keys are safe to expose in the browser.

### `NEXT_PUBLIC_POSTHOG_HOST`

PostHog instance host URL. Defaults to `https://app.posthog.com` (PostHog Cloud).

- **Optional.** Only needed if using a self-hosted PostHog instance.

### `CONTRACT_SYNC_MIN_INTERVAL_MS`

Minimum time between `/api/contract-sync` runs; a trigger inside this window returns `{ status: "skipped" }` instead of re-running Horizon checks for every registration. Defaults to `60000` (1 minute).

---

## Vercel configuration

1. Project → **Settings** → **Environment Variables**
2. Add all required variables for **Production**, **Preview**, and **Development**
3. Redeploy after changes

For preview deployments, set `NEXTAUTH_URL` to the preview URL or use Vercel's automatic `VERCEL_URL` pattern in custom auth config if needed.

---

## Rate-Limit Headers

Public API endpoints (`/api/check`, `/api/actions/lookup`, `/api/stats`) emit standard rate-limit response headers on every response:

| Header | Description |
|--------|-------------|
| `RateLimit-Limit` | Max requests allowed per window (default: 10 for `/api/check`, 60 for lookup, 120 for stats) |
| `RateLimit-Remaining` | Requests remaining in the current window |
| `RateLimit-Reset` | Seconds until the window resets |
| `Retry-After` | Seconds to wait before retrying (only on 429 responses) |

These follow the [IETF RateLimit Headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers-07/) standard.

**Multi-instance note:** The rate limiter uses an in-memory sliding window. When running behind a load balancer with N instances, the effective limit is approximately `N × maxRequests`. For strict per-client limits, consider a shared store (Redis, etc.) — but the current approach is sufficient for abuse prevention.

---

## Security checklist

- [ ] Never commit `.env.local` or secrets
- [ ] Rotate `GITHUB_CLIENT_SECRET` if exposed
- [ ] Use `sslmode=require` for remote Postgres
- [ ] Generate unique `NEXTAUTH_SECRET` per environment

---

## Related docs

- [Setup guide](./SETUP.md)
- [Deployment](./DEPLOYMENT.md)
- [Architecture](./ARCHITECTURE.md)

- // src/lib/notifications/webhook.ts

export type WebhookPayload = {
  event: string;
  message: string;
  count?: number;
  timestamp: string;
};

const MAX_MESSAGE_LENGTH = 2000;

function validateWebhookUrl(value: string): URL {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("Webhook URL must not contain credentials");
  }

  return url;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/G[A-Z0-9]{20,}/gi, "[redacted-address]")
    .replace(/0x[a-fA-F0-9]{40}/g, "[redacted-address]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

export async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<void> {
  const url = validateWebhookUrl(webhookUrl);

  const body = {
    ...payload,
    message: sanitizeMessage(payload.message),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
// src/lib/notifications/notify.ts

import { sendWebhook } from "./webhook";

type NotificationConfig = {
  dropThreshold?: number;
  notReadyThreshold?: number;
  webhookUrl?: string;
};

type DropEvent = {
  collection: string;
  count: number;
};

type ReadinessEvent = {
  count: number;
};

const lastPost = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

function canPost(key: string): boolean {
  const now = Date.now();
  const previous = lastPost.get(key) ?? 0;

  if (now - previous < RATE_LIMIT_MS) {
    return false;
  }

  lastPost.set(key, now);
  return true;
}

function getConfig(): NotificationConfig {
  return {
    webhookUrl: process.env.WAVE_WEBHOOK_URL,
    dropThreshold: Number(process.env.WAVE_DROP_THRESHOLD ?? 10),
    notReadyThreshold: Number(
      process.env.WAVE_NOT_READY_THRESHOLD ?? 10,
    ),
  };
}

export async function notifyDropBelowThreshold(
  event: DropEvent,
): Promise<boolean> {
  const config = getConfig();

  if (!config.webhookUrl) return false;

  if (event.count > (config.dropThreshold ?? 10)) {
    return false;
  }

  if (!canPost("drop-threshold")) {
    return false;
  }

  await sendWebhook(config.webhookUrl, {
    event: "drop_below_threshold",
    message:
      `Collection ${event.collection} dropped below threshold. ` +
      `Current count: ${event.count}.`,
    count: event.count,
    timestamp: new Date().toISOString(),
  });

  return true;
}

export async function notifyNotReadySpike(
  event: ReadinessEvent,
): Promise<boolean> {
  const config = getConfig();

  if (!config.webhookUrl) return false;

  if (event.count < (config.notReadyThreshold ?? 10)) {
    return false;
  }

  if (!canPost("not-ready-spike")) {
    return false;
  }

  await sendWebhook(config.webhookUrl, {
    event: "not_ready_spike",
    message:
      `Not-ready item count has spiked. ` +
      `Current count: ${event.count}.`,
    count: event.count,
    timestamp: new Date().toISOString(),
  });

  return true;
}


# Environment Variables

## Wave Notifications

### `WAVE_WEBHOOK_URL`

Optional HTTPS webhook used for Wave operational notifications.

Example:

WAVE_WEBHOOK_URL=https://example.com/webhook

Only HTTPS webhook URLs are accepted.

Do not commit webhook URLs to Git.

Do not print the webhook URL in logs, errors, or test output.

### `WAVE_DROP_THRESHOLD`

Controls when a low-drop notification is emitted.

Default:

WAVE_DROP_THRESHOLD=10

### `WAVE_NOT_READY_THRESHOLD`

Controls when a not-ready spike notification is emitted.

Default:

WAVE_NOT_READY_THRESHOLD=10

## Privacy

Notifications do not include wallet addresses by default.

Counts and operational events are preferred over individual records.

If an address is ever required for debugging, it must be
redacted or hashed before being sent to the webhook.

## Rate Limiting

Notifications are limited to one message per notification type
per minute to prevent webhook spam.

## Security

Webhook URLs must use HTTPS.

Webhook credentials must not be embedded in URLs.

Webhook URLs must never be logged.

Notification messages must not contain unnecessary PII.
