# API Keys

Maintainers can create short-lived API keys that gate treasury export automation
and other privileged operations without sharing GitHub credentials.

← Back to [ARCHITECTURE.md](./ARCHITECTURE.md) | [README](../README.md)

---

## Overview

| Route | Method | Guard | Purpose |
|-------|--------|-------|---------|
| `/api/settings/api-keys` | `GET` | Maintainer session | List all keys (no raw value) |
| `/api/settings/api-keys` | `POST` | Maintainer session + CSRF | Create key — raw value returned once |
| `/api/settings/api-keys/[id]` | `DELETE` | Maintainer session + CSRF | Revoke key (soft delete) |

---

## Key lifecycle

```
Create → raw key shown once → stored as SHA-256 hash only
         ↓
      Active (revokedAt = null)
         ↓
      Revoke → revokedAt = now()   ← soft delete, row retained for audit
```

The raw key is **never stored**. Only its SHA-256 hex digest (`keyHash`) is
persisted in the `ApiKey` table. If a key is lost after creation it cannot be
recovered — create a new one and revoke the old one.

---

## Scopes

| Scope | Description |
|-------|-------------|
| `treasury:read` | Read treasury balances and contributor readiness |
| `treasury:export` | Download the Wave payout CSV |
| `contributors:read` | Read contributor registrations |
| `contributors:write` | Trigger re-checks and batch operations |

Scopes are stored as a `String[]` column on the `ApiKey` row and validated
server-side against `VALID_SCOPES` in `src/app/api/settings/api-keys/route.ts`.
An invalid scope in the `POST` body returns `400`.

---

## UI — ApiKeyPanel

`src/components/ApiKeyPanel.tsx` renders on the maintainer settings page.

### Test IDs (data-testid)

| testid | Element |
|--------|---------|
| `api-key-panel` | Root card |
| `maintainer-only-message` | Message shown to non-maintainers |
| `raw-key-banner` | One-time secret reveal banner |
| `raw-key-value` | `<code>` containing the raw key |
| `copy-raw-key-button` | Clipboard copy button |
| `dismiss-raw-key-button` | Banner dismiss button |
| `create-api-key-form` | Create form wrapper |
| `api-key-name-input` | Name text input |
| `scope-checkboxes` | Scope checkbox group wrapper |
| `scope-checkbox-{scope}` | Individual scope checkbox (e.g. `scope-checkbox-treasury:read`) |
| `create-api-key-button` | Submit button |
| `create-error` | Inline create error message |
| `api-key-list` | Existing keys list wrapper |
| `api-key-row-{id}` | Individual key row |
| `revoke-button-{id}` | Revoke button on an active key |
| `revoked-badge-{id}` | "Revoked" badge on a revoked key |
| `revoke-error` | Inline revoke error message |

---

## Security notes

- **One-time disclosure** — the raw key is returned in `POST` response body
  exactly once and never stored; it cannot be retrieved from the API afterwards.
- **Hash storage** — `ApiKey.keyHash` is a SHA-256 hex digest. It cannot be
  reversed to obtain the raw key.
- **Soft delete** — `DELETE` sets `revokedAt`; the row is retained for audit.
  Hard deletes are not supported through the API.
- **Maintainer-only** — all three endpoints verify `session.user.isMaintainer`.
  A non-maintainer (including an unauthenticated request) receives `403`.
- **CSRF** — `POST` and `DELETE` routes call `assertSameOrigin()` before
  touching the session.

---

## Database model

```prisma
model ApiKey {
  id        String    @id @default(cuid())
  name      String
  keyHash   String    @unique   // SHA-256 hex digest
  scopes    String[]
  createdAt DateTime  @default(now())
  revokedAt DateTime?           // null = active, non-null = revoked
}
```

---

## Testing

Tests live in `src/components/ApiKeyPanel.test.tsx` and cover:

- `GET` — 403 for unauthenticated / non-maintainer, 200 with key list for maintainer
- `POST` — CSRF guard, 403 for non-maintainer, 400 for missing name, 400 for
  invalid scope, 201 with `rawKey` present exactly once, hash stored not plaintext
- `DELETE` — CSRF guard, 403 for non-maintainer, 404 for missing id, 409 for
  already-revoked, 200 soft-delete with `revokedAt` set

Run with:

```bash
npm test
# or target just this file:
npx vitest run src/components/ApiKeyPanel.test.tsx
```
