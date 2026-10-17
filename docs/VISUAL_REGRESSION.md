# Visual Regression Testing Guide

TrustBridge Dashboard uses Playwright to capture full-page visual regression screenshots across key user workflows in both light and dark color schemes.

## Covered Views
- **Landing Page** (`/`): Light & Dark modes
- **Register Flow** (`/register`): Light & Dark modes (with mocked contributor registration)
- **Dashboard** (`/dashboard`): Light & Dark modes (with mocked contributor table and metrics)

## Running Visual Tests

To run the visual regression test suite:

```bash
npx playwright test tests/e2e/visual.spec.ts
```

To run with UI mode for debugging:

```bash
npm run test:e2e:ui
```

## Updating Golden Snapshots

When intentional UI design changes or component layouts are updated, golden baseline screenshots must be regenerated:

```bash
# Update golden snapshots across all visual test suites
npx playwright test tests/e2e/visual.spec.ts --update-snapshots
```

Commit the generated snapshot image files under `tests/e2e/visual.spec.ts-snapshots/` with your PR.

## Preventing Flakiness
- **Timestamp Masking**: Dynamic timestamps, relative time strings, and Horizon latency metrics are masked using Playwright's `mask` locator array so changing times never fail visual diffs.
- **Deterministic Mock Data**: API responses from `/api/register` and `/api/contributors` are intercepted using `interceptApi` to ensure consistent data and avoid live network delays or Horizon rate limits.
- **Font Rendering Settle**: `waitForLoadState("networkidle")` is asserted before screenshot captures.
