# Visual Regression Testing Guide

TrustBridge Dashboard uses Playwright to capture visual regression screenshots across key user workflows and component states in both light and dark color schemes.

## Covered Views

### Full-page views
- **Landing Page** (`/`): Light & Dark modes
- **Register Flow** (`/register`): Light & Dark modes (with mocked contributor registration)
- **Dashboard** (`/dashboard`): Light & Dark modes (with mocked contributor table and metrics)

### ContributorTable column states
These tests target the `[data-testid="contributor-table-region"]` element directly so
layout changes outside the table don't cause false positives.

| Snapshot | Description |
|---|---|
| `contributor-table-default-columns-light.png` | Default column set (spendableXlmBalance hidden) — light |
| `contributor-table-default-columns-dark.png` | Default column set — dark |
| `contributor-table-all-columns-light.png` | All columns visible after enabling Spendable XLM via column picker |
| `contributor-table-column-picker-open-light.png` | Column picker panel open |
| `contributor-table-minimal-columns-light.png` | Only GitHub + Status columns visible |
| `contributor-table-all-states-light.png` | All readiness states (ready / low_reserve / not_ready) + banned badge — light |
| `contributor-table-all-states-dark.png` | All readiness states + banned badge — dark |
| `contributor-table-zero-empty-light.png` | Zero-contributors empty state |

### Readiness panel & wave-status banners (light & dark) (#794)
These baselines target the Wave readiness panel (`[data-testid="wave-readiness-panel"]`)
and Wave status banners (`[data-testid="freeze-window-banner"]`,
`[data-testid="stale-data-banner"]`) in both light and dark modes so unreviewed UI
drift cannot confuse Wave contributors or maintainers. The canonical baseline catalog
lives in `src/lib/readiness.ts` (`READINESS_VISUAL_BASELINES`,
`WAVE_STATUS_BANNER_BASELINES`, `ALL_VISUAL_BASELINES`) and is verified against this
document and `tests/e2e/visual.spec.ts` on every CI run.

| Snapshot | Target `data-testid` | Color scheme | Description |
|---|---|---|---|
| `readiness-panel-all-states-light.png` | `wave-readiness-panel` | Light | Wave readiness panel showing mixed `ready` / `low_reserve` / `not_ready` progress |
| `readiness-panel-all-states-dark.png` | `wave-readiness-panel` | Dark | Wave readiness panel showing mixed `ready` / `low_reserve` / `not_ready` progress |
| `readiness-panel-zero-empty-light.png` | `wave-readiness-panel` | Light | Wave readiness panel with `0/0` contributors (0% bar) |
| `readiness-panel-zero-empty-dark.png` | `wave-readiness-panel` | Dark | Wave readiness panel with `0/0` contributors (0% bar) |
| `wave-status-banner-freeze-light.png` | `freeze-window-banner` | Light | Active Wave freeze window alert banner |
| `wave-status-banner-freeze-dark.png` | `freeze-window-banner` | Dark | Active Wave freeze window alert banner |
| `wave-status-banner-stale-warning-light.png` | `stale-data-banner` | Light | Stale contributor data warning banner (`<50%` stale) |
| `wave-status-banner-stale-warning-dark.png` | `stale-data-banner` | Dark | Stale contributor data warning banner (`<50%` stale) |
| `wave-status-banner-stale-critical-light.png` | `stale-data-banner` | Light | Stale contributor data critical banner (`>=50%` stale or never verified) |
| `wave-status-banner-stale-critical-dark.png` | `stale-data-banner` | Dark | Stale contributor data critical banner (`>=50%` stale or never verified) |

#### Baseline catalog validation & reason codes
Run the Vitest catalog + docs sync check (no browser required; runs in CI):

```bash
npx vitest run src/lib/visual-regression-baselines.test.ts
```

`validateVisualBaselineCatalog()` and `verifyVisualBaselineDocsSync()` in
`src/lib/readiness.ts` emit stable reason codes (`VISUAL_BASELINE_REASON_CODES`):
- `INVALID_SNAPSHOT_NAME` — snapshot filename is empty or does not match `^[a-z0-9][a-z0-9-]{2,120}\.png$`
- `DUPLICATE_SNAPSHOT_NAME` — two entries claim the same snapshot filename
- `INVALID_TEST_ID` — target `data-testid` is empty or malformed
- `INVALID_DIFF_THRESHOLD` — `maxDiffPixelRatio` is not a finite number in `(0, 0.1]`
- `MISSING_COLOR_SCHEME_PAIR` — a baseline group does not cover both `light` and `dark`
- `MISSING_DOC_BASELINE` — a catalog snapshot is missing from `docs/VISUAL_REGRESSION.md`
- `MISSING_SPEC_COVERAGE` — a catalog snapshot is missing from `tests/e2e/visual.spec.ts`

## Running Visual Tests

Run the full visual suite:

```bash
npx playwright test tests/e2e/visual.spec.ts
```

Run only the readiness panel & wave-status banner tests:

```bash
npx playwright test tests/e2e/visual.spec.ts --grep "Readiness panel & wave-status banners"
```

Run only the contributor-table column tests:

```bash
npx playwright test tests/e2e/visual.spec.ts --grep "ContributorTable columns"
```

Run with UI mode for debugging:

```bash
npm run test:e2e:ui
```

## Updating Golden Snapshots

When intentional UI design changes or component layouts are updated, golden baseline screenshots must be regenerated:

```bash
# Update all visual snapshots
npx playwright test tests/e2e/visual.spec.ts --update-snapshots

# Update only contributor-table snapshots
npx playwright test tests/e2e/visual.spec.ts --grep "ContributorTable columns" --update-snapshots
```

Commit the generated snapshot image files under `tests/e2e/visual.spec.ts-snapshots/` with your PR.

## Preventing Flakiness
- **Timestamp Masking**: Dynamic timestamps, relative time strings, and Horizon latency metrics are masked using Playwright's `mask` locator array so changing times never fail visual diffs.
- **Deterministic Mock Data**: API responses (`/api/contributors*`, `/api/soroban/events`, `/api/settings/network`, `/api/freeze-status`) are intercepted using `interceptApi` to ensure consistent data and avoid live network delays or Horizon rate limits.
- **Scroll into view**: The contributor-table tests scroll the region into view before capturing so the element is fully painted.
- **Font Rendering Settle**: `waitForLoadState("networkidle")` is asserted before screenshot captures.

## Adding New Column / State Tests

1. Add your fixture rows to `COLUMN_TEST_CONTRIBUTORS` in `tests/e2e/visual.spec.ts` (or pass a custom array to `interceptContributorApis`).
2. Add a new `test()` block inside `test.describe("Visual Regression — ContributorTable columns")`.
3. Run with `--update-snapshots` to generate the golden baseline.
4. Commit the `.png` snapshot alongside the spec change.

## Automated WCAG contrast gate (status chips)

Playwright screenshots prove that a component renders; they **do not measure
WCAG contrast**. A pixel snapshot can look "fine" while a label fails AA, so
contrast is enforced separately by a pure Vitest audit:

```bash
npx vitest run src/lib/dark-mode-contrast-audit.test.ts
```

This command is the CI gate for colour-pair changes and must pass before a
snapshot is regenerated. Thresholds (WCAG 2.1):

| Content | Minimum ratio |
|---|---|
| Normal text (< 18 pt, or < 14 pt bold) | 4.5:1 |
| Large text (>= 18 pt, or >= 14 pt bold) | 3:1 |
| UI components / meaningful boundaries (non-text) | 3:1 |

Wave status chips use the shared map in `src/lib/wave-status.ts`:
`pass -> ready/emerald`, `fail -> danger/red`, `skipped -> warning/amber`,
`frozen -> warning/amber`. Amber is deliberately chosen for skipped **and**
frozen: a frozen payout round must stay visible, not fade into a neutral grey.
The audit iterates all four statuses and checks light text on white, dark text
on `--card`, and the border tokens used by visible status badges against their
surfaces. The shared badge variants have `border-transparent`, so they claim no
separate non-text boundary.

### Exceptions register

No exceptions are currently approved. Any waiver must be reviewed and given an
owner and expiry here before the gate is relaxed:

| Component | Pair | Ratio | Reason | Owner | Expiry |
|---|---|---|---|---|---|
| — | — | — | No exceptions | — | — |

When a real exception is needed, add a row with the component, foreground/background
pair, measured ratio, business reason, named owner, and a fixed expiry date. An
empty `Owner` or `Expiry` is not a valid exception. Prefer changing the colour
stop to a compliant one (see the audited pairs in `src/components/ui/badge.tsx`)
over adding a waiver.
