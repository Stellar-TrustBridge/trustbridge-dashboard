# Badge Signing & Rotation

← Back to [README](../README.md) · See also [API Keys](./API_KEYS.md) · [Security](./CSRF.md)

## Overview

TrustBridge contributor readiness badges (`/api/badge/[username]`) use HMAC-SHA256 signatures to prevent unauthorized SVG generation and hotlink spoofing. Each badge URL includes a `sig` query parameter computed from the contributor's GitHub username and a secret key.

## Why signing matters

Without signatures, anyone could generate forged badges showing contributors as "ready" when they're not, potentially misleading Wave maintainers during payout review.

Signature verification happens at every `/api/badge/[username]` request. Invalid or missing signatures return `401 Unauthorized` rather than rendering an SVG.

## Key hierarchy & rotation

The badge signing key resolves with the following fallback order:

1. **`BADGE_SIGNING_KEY`** (preferred) — Dedicated signing key
2. **`NEXTAUTH_SECRET`** — NextAuth session secret
3. **`TOKEN_ENCRYPTION_KEY`** — GitHub access token encryption key
4. Development fallback (non-production only)

### When to rotate

Rotate the badge signing key immediately if:

- The key is exposed in logs, commits, or error traces
- A maintainer with key access leaves the org
- You suspect badge URL forgery (unexpected "ready" badges)

Rotate proactively:

- Every 90 days as part of routine key rotation
- After a security incident affecting any Wave infrastructure

### How to rotate without breaking existing badges

**Step 1: Generate a new key**

```bash
openssl rand -base64 32
```

**Step 2: Update environment with the new key**

Set `BADGE_SIGNING_KEY` in your production environment (Vercel dashboard, `.env.local`, etc.):

```bash
BADGE_SIGNING_KEY=<new-key-from-step-1>
```

**Step 3: Redeploy**

All requests after deployment use the new key. Previously signed badge URLs become invalid within seconds.

**Step 4: Maintainers regenerate badge URLs**

Contributors whose READMEs embed old signed badge URLs will see `401 Unauthorized` SVG placeholders until they regenerate:

1. Visit the dashboard `/register` page
2. Re-copy the badge markdown snippet
3. Update their README

The Stellar address and readiness verdict are unchanged — only the signature rotates.

### Optional: time-limited signatures

For higher-security deployments, enable signature expiration:

```typescript
import { generateBadgeUrl } from "@/lib/badge-signing";

const url = generateBadgeUrl("alice", {
  baseUrl: "https://trustbridge.example.com",
  expiresInSeconds: 86400, // 24 hours
});
```

The URL includes an `exp` query parameter; requests after expiration fail verification.

**Tradeoff:** Contributors must regenerate badge URLs every 24 hours (or whatever TTL you choose). This is impractical for public READMEs but useful for internal dashboards or time-limited invitations.

## Signature format

Each badge URL follows this structure:

```
/api/badge/alice?sig=<64-char-hex>&exp=<unix-timestamp>
```

- **`sig`**: HMAC-SHA256 hex digest of `username:expiresAt`, where `expiresAt` defaults to `0` for permanent signatures
- **`exp`** (optional): UNIX timestamp in seconds; signature is invalid after this time

## Security properties

✅ **Tamper-proof**: Modifying `username`, `exp`, or the signature itself causes verification to fail.

✅ **Timing-safe**: Verification uses `timingSafeEqual` to prevent timing side-channel attacks.

✅ **No PII in output**: The badge SVG contains only the readiness status (`ready` | `low_reserve` | `not_ready` | `unknown`) — never the Stellar address, email, or full name.

✅ **No secrets in URLs**: The signing key is server-only; clients never see it.

## Testing

The badge signing test suite (`src/lib/badge-signing.test.ts`) covers:

- **Key resolution**: fallback hierarchy, production guard
- **Signature generation**: correct 64-character hex output
- **Verification**: valid signatures pass, tampered/expired/mismatched signatures fail
- **URL generation**: correct relative/absolute URL construction with optional expiration

Run:

```bash
npm test -- badge-signing
```

### Rejection of tampered payloads

The test suite includes explicit tampered-signature cases:

```typescript
it("fails verification for a tampered signature", () => {
  const sig = signBadge("alice");
  const tampered = sig.substring(0, 63) + (sig.endsWith("0") ? "1" : "0");
  expect(verifyBadgeSignature("alice", tampered)).toBe(false);
});
```

Any single-bit flip in the 64-character hex signature causes verification to fail. This prevents attackers from:

- Flipping a "not ready" signature to appear valid for a "ready" status
- Reusing a signature across different usernames
- Extending signature expiration by modifying the `exp` timestamp

**Real-world impact:** A forged badge URL landing in a maintainer's payout checklist would be rejected before the SVG is rendered, preserving the integrity of the Wave readiness signal.

## API integration

Badge URLs are generated in two places:

1. **Dashboard `/register` page**: Copy-paste markdown snippet for contributor READMEs
2. **`GET /api/contributors` response**: Each `ContributorRow` includes a `badgeUrl` field

Example response:

```json
{
  "contributors": [
    {
      "githubUsername": "alice",
      "readiness": "ready",
      "badgeUrl": "/api/badge/alice?sig=a1b2c3d4..."
    }
  ]
}
```

Maintainers can hotlink these URLs in dashboards, or contributors can embed them in markdown:

```markdown
![TrustBridge Status](https://trustbridge.example.com/api/badge/alice?sig=a1b2c3d4...)
```

## Troubleshooting

### Badge shows "401 Unauthorized"

**Cause:** Signature verification failed.

**Fix:**
1. Check that `BADGE_SIGNING_KEY` (or a fallback) is configured in production
2. Regenerate the badge URL from the dashboard — the old signature may be stale
3. Verify the URL wasn't truncated or modified when copy-pasting

### Badge shows "unknown" status

**Cause:** The contributor isn't registered, or the GitHub username doesn't match any registration.

**Fix:**
1. Verify the contributor has completed `/register` with a valid Stellar address
2. Check the spelling of the GitHub username in the badge URL (case-sensitive)

### Key rotation broke all existing badges

**Expected behavior.** After rotating `BADGE_SIGNING_KEY`, all previously signed URLs become invalid. Contributors must regenerate badge markdown from the dashboard.

**Migration tip:** If you need zero-downtime rotation, temporarily accept both old and new keys by:
1. Deploying a custom `verifyBadgeSignature` that tries both keys
2. Waiting 7 days for contributors to regenerate
3. Removing old key support

This is overkill for most teams — the standard "rotate and notify" flow is sufficient.

## Further reading

- [HMAC signature verification (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign#hmac)
- [Timing-safe equality (Node.js crypto)](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)
- [Badge SVG generation](../src/lib/badge-svg.ts)
- [API Keys documentation](./API_KEYS.md)
