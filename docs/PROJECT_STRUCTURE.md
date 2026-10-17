# Project Structure

Directory layout and responsibilities for TrustBridge Dashboard.

← Back to [README](../README.md) · See also [Architecture](./ARCHITECTURE.md)

---

## Root directory

```
trustbridge-dashboard/
├── docs/                 # Project documentation (you are here)
├── prisma/
│   ├── schema.prisma     # Database schema (User, Registration, TokenAuditLog, NextAuth models)
│   └── migrations/       # Prisma migration history
├── scripts/              # Build-time helper scripts for Prisma/Next
├── src/
│   ├── app/              # Next.js App Router pages & API routes
│   ├── components/       # React components
│   ├── lib/              # Server utilities, auth, Horizon, Prisma
│   ├── types/            # Shared TypeScript types
│   └── middleware.ts     # Auth route protection
├── .env.example          # Environment variable template
├── components.json       # shadcn/ui configuration
├── tailwind.config.ts    # Tailwind + Stellar brand tokens
├── next.config.mjs       # Next.js config (webpack externals for stellar-sdk)
├── package-lock.json     # npm lockfile
└── package.json
```

---

## `src/app/` — Routes

| Path | Type | File |
|------|------|------|
| `/` | Server page | `app/page.tsx` |
| `/register` | Client page | `app/register/page.tsx`, `RegisterClient.tsx` |
| `/dashboard` | Client page | `app/dashboard/page.tsx` |
| `/api/auth/[...nextauth]` | Route handler | `app/api/auth/[...nextauth]/route.ts` |
| `/api/check` | Route handler | `app/api/check/route.ts` |
| `/api/register` | Route handler | `app/api/register/route.ts` |
| `/api/contributors` | Route handler | `app/api/contributors/route.ts` |
| `/api/stats` | Route handler | `app/api/stats/route.ts` |
| `/api/actions/lookup` | Route handler | `app/api/actions/lookup/route.ts` |
| `/api/soroban/events` | Route handler | `app/api/soroban/events/route.ts` |

Global styles: `app/globals.css`  
Root layout: `app/layout.tsx`

---

## `src/components/` — UI

```
components/
├── ui/                      # shadcn-style primitives
│   ├── button.tsx
│   ├── card.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── badge.tsx
│   └── separator.tsx
├── icons/
│   └── GitHubIcon.tsx
├── AddressInput.tsx         # Debounced Horizon validation input
├── ContributorTable.tsx     # Maintainer table + CSV export
├── SorobanEventTimeline.tsx # Maintainer Soroban event table + filters + CSV export
├── Header.tsx               # Nav, auth, theme toggle
├── Providers.tsx            # Session, React Query, theme providers
├── TrustlineGuidancePanel.tsx
├── TrustlineStatusBadge.tsx
└── WaveReadinessBar.tsx
```

---

## `src/lib/` — Business logic

| File | Purpose |
|------|---------|
| `auth.ts` | NextAuth config, GitHub OAuth, maintainer org check, encrypted token storage |
| `token-crypto.ts` | AES-256-GCM encrypt/decrypt for tokens at rest |
| `token-audit.ts` | Best-effort audit trail for token encrypt/decrypt events |
| `constants.ts` | Horizon URL, default asset, external links |
| `horizon.ts` | Stellar Horizon account/trustline queries |
| `stellar.ts` | Address validation, readiness computation |
| `action-lookup.ts` | Wizard `nextAction` guidance from a Horizon check result |
| `soroban.ts` | Soroban RPC event timeline fetch (server-only) |
| `soroban-events.ts` | Pure filter/sort helpers for the event timeline panel |
| `prisma.ts` | Prisma client singleton |
| `registrations.ts` | Stats, contributor list, batch refresh |
| `utils.ts` | `cn()` helper, date formatting |

---

## `scripts/` — Build helpers

| File | Purpose |
|------|---------|
| `prisma-generate.mjs` | Runs `prisma generate`, using a placeholder PostgreSQL URL only when `DATABASE_URL` is unset or empty at build time |
| `next-build.mjs` | Runs `next build`, supplying build-time placeholders for required server-only env vars when CI/preview builds do not provide real secrets |

---

## `src/types/`

| File | Purpose |
|------|---------|
| `index.ts` | `HorizonCheckResult`, `ContributorRow`, `ReadinessStatus`, etc. |
| `next-auth.d.ts` | Session/JWT type extensions |

---

## `docs/` — Documentation map

| File | Description |
|------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design & data flows |
| [SETUP.md](./SETUP.md) | Local development setup |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Env var reference |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Vercel deployment |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution guidelines |
| [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) | This file |

All docs link back to the [README](../README.md).

---

## Key npm scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `next dev` | Local development |
| `build` | `npm run prisma:generate && node scripts/next-build.mjs` | Production build |
| `start` | `next start` | Run production server |
| `prisma:generate` | `node scripts/prisma-generate.mjs` | Generate Prisma client safely during installs/builds |
| `lint` | `next lint` | ESLint |
| `test` | `vitest run` | Unit tests |
| `db:push` | `prisma db push` | Sync schema to DB |
| `db:migrate` | `prisma migrate dev` | Create migration |
| `db:studio` | `prisma studio` | DB GUI |

---

## Related docs

- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)
