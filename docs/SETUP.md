# Setup

This guide covers local development, environment configuration, and the
end-to-end readiness flow for the TrustBridge dashboard.

## Prerequisites

- Node.js 20+
- npm 10+
- A local or remote Stellar Horizon endpoint (see `HORIZON_URL`)

## Install

```bash
npm install
```

## Environment

Copy the example env file and fill in the values:

```bash
cp .env.example .env.local
```

Key variables:

| Variable | Purpose |
| --- | --- |
| `HORIZON_URL` | Horizon endpoint used for readiness checks |
| `NEXT_PUBLIC_APP_URL` | Public base URL of the dashboard |
| `REGISTRY_MODE` | Registry mode (`live` / `mock`); fails closed on invalid values |

## Run locally

```bash
npm run dev
```

The dashboard is served at `http://localhost:3000`.

## Readiness flow (operator notes)

Registration readiness is evaluated by `src/lib/readiness.ts` and rechecked
via `POST /api/register/recheck`. A registration can fail readiness (for
example, an unfunded account or a missing trustline), the operator funds the
account and establishes the trustline, and then triggers an Action recheck
that should pass.

Reason codes surfaced by readiness and recheck:

- `account-unfunded` — account has no funds on Horizon
- `account-no-trustline` — account is missing the required trustline
- `account-low-balance` — balance below the minimum reserve
- `account-funded` — account is funded and ready
- `rate-limited` — Horizon returned a rate-limit response

For the full step-by-step walkthrough (including mock Horizon mappings and
sample output), see [`docs/E2E_TESTING.md`](./E2E_TESTING.md).

## Tests

```bash
npm test
```

Targeted readiness/recheck tests:

```bash
npm test -- readiness recheck
```
