# Setup

This guide covers local development setup for the TrustBridge dashboard, including the mock Horizon service used by Wave contributors.

## Prerequisites

- Node.js (see `package.json` for the supported version)
- Docker and Docker Compose (for the local mock Horizon stack)
- A `.env.local` file with the required environment variables

## Quick start

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the required values.
3. Start the local mock Horizon stack: `docker compose up -d`
4. Run the dev server: `npm run dev`

## Local mock Horizon

The mock Horizon service is defined in `docker-compose.yml` and documented in
`docs/DOCKER_COMPOSE.md`. Before starting the stack, review the recommended
CPU/memory limits there — under-resourced local stacks can produce false Wave
check failures (including OOM-killed containers and failing healthchecks).

If a container exits unexpectedly or a healthcheck fails, see the
"Resource limits" and "OOM troubleshooting" sections of
`docs/DOCKER_COMPOSE.md` for diagnosis steps.

## Environment variables

See `.env.example` for the full list of supported variables. Document any new
inputs or env vars in this file and in the relevant `docs/` page.

## Running checks

- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Tests: `npm test`
