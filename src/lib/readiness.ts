import type { WizardAction } from "@/lib/action-lookup";
import { BASE_RESERVE_XLM, MIN_XLM_BALANCE } from "@/lib/constants";
import type { HorizonCheckResult, ReadinessStatus } from "@/types";

export interface ReadinessDisplayConfig {
  /** Badge text. Short enough to sit in a table cell. */
  label: string;
  variant: "ready" | "warning" | "danger";
  icon: string;
  /**
   * One sentence of plain language explaining what the state means for the
   * contributor. No Stellar vocabulary that is not explained in place.
   */
  description: string;
  /** The single next thing the contributor shouldo. */
  nextStep: string;
  /**
   * Reason codes that can produce this status, in the order
   * `computeNextAction()` checks them. Keeps the badge copy honest against
   * `WIZARD_ACTION_COPY` — see `readiness-copy.test.ts`.
   */
  reasonCodes: WizardAction[];
}

/**
 * Canonical parity mapping between `ReadinessStatus` values, the `WizardAction`
 * reason codes that produce them, and the minimum `HorizonCheckResult` shape
 * needed to reach each status.
 *
 * This table is the **single source of truth** for readiness→reason-code
 * correspondence. It is imported by `readiness-copy.test.ts` and by
 * `check-api.ts` integration tests to verify that the full pipeline
 * (`HorizonCheckResult` → `computeReadiness` → `getReadinessConfig` →
 * `computeNextAction`) stays consistent when either side changes.
 *
 * Columns:
 * - `readiness` — the `ReadinessStatus` the account ends up in.
 * - `action`    — the `WizardAction` reason code the wizard returns for that account.
 * - `fields`    — minimal Horizon field values that produce this combination.
 *
 * Rules enforced by tests:
 * 1. Every `ReadinessStatus` appears exactly once.
 * 2. Every `WizardAction` appears exactly once.
 * 3. `computeNextAction(fields)` returns `action` for every row.
 * 4. `getReadinessConfig(readiness).reasonCodes` contains `action` for every row.
 * 5. `computeReadiness` with `fields` returns `readiness` for every row.
 */
export const READINESS_ACTION_PARITY_TABLE = [
  {
    readiness: "not_ready" as const,
    action: "fund_account" as const,
    description: "unfunded account",
    fields: {
      funded: false,
      trustline: false,
      trustline_authorized: false,
      xlm_balance: "0",
      spendable_xlm_balance: "0",
    },
  },
  {
    readiness: "not_ready" as const,
    action: "add_trustline" as const,
    description: "funded, no trustline",
    fields: {
      funded: true,
      trustline: false,
      trustline_authorized: false,
      xlm_balance: "2",
      spendable_xlm_balance: "1",
    },
  },
  {
    readiness: "not_ready" as const,
    action: "await_trustline_authorization" as const,
    description: "funded + trustline present but unauthorized",
    fields: {
      funded: true,
      trustline: true,
      trustline_authorized: false,
      xlm_balance: "2",
      spendable_xlm_balance: "1",
    },
  },
  {
    readiness: "low_reserve" as const,
    action: "increase_reserve" as const,
    description: "funded + authorized trustline, spendable XLM below floor",
    fields: {
      funded: true,
      trustline: true,
      trustline_authorized: true,
      xlm_balance: "2",
      spendable_xlm_balance: "0.1",
    },
  },
  {
    readiness: "ready" as const,
    action: "none" as const,
    description: "fully ready account",
    fields: {
      funded: true,
      trustline: true,
      trustline_authorized: true,
      xlm_balance: "10",
      spendable_xlm_balance: "5",
    },
  },
] as const;



export function parseXlmBalance(xlmBalance: string): number {
  const parsed = Number.parseFloat(xlmBalance ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SpendableBalanceOptions {
  /** XLM reserved per subentry/sponsorship unit. Defaults to `BASE_RESERVE_XLM`. */
  baseReserve?: number;
  subentryCount?: number;
  numSponsoring?: number;
  numSponsored?: number;
  /** Native balance line's `selling_liabilities`, if any (not spendable). */
  sellingLiabilities?: string;
}

/**
 * Every Stellar account must keep a minimum reserve of
 * `baseReserve * (2 + subentries + sponsoring - sponsored)` locked up, and
 * any XLM committed to open sell offers (`selling_liabilities`) is likewise
 * unavailable for payments. The raw native balance therefore overstates what
 * an account can actually spend — this computes the true spendable amount.
 */
export function computeSpendableXlmBalance(
  rawBalance: string,
  opts: SpendableBalanceOptions = {}
): string {
  const {
    baseReserve = BASE_RESERVE_XLM,
    subentryCount = 0,
    numSponsoring = 0,
    numSponsored = 0,
    sellingLiabilities = "0",
  } = opts;

  const raw = parseXlmBalance(rawBalance);
  const liabilities = parseXlmBalance(sellingLiabilities);
  const reserveUnits = 2 + subentryCount + numSponsoring - numSponsored;
  const reserve = baseReserve * Math.max(0, reserveUnits);

  const spendable = raw - reserve - liabilities;
  return Math.max(0, spendable).toFixed(7);
}

export interface ReadinessOptions {
  minimumBalance?: number;
  /**
   * Whether the trustline is authorized by the asset issuer. A trustline that
   * is present but unauthorized cannot receive the asset, so it is treated as
   * not ready. Defaults to `true` for callers that do not track authorization.
   */
  authorized?: boolean;
  /**
   * Spendable XLM balance (raw balance minus reserve and liabilities). When
   * provided, this is used for the reserve check instead of the raw balance.
   */
  spendableBalance?: string;
}

export function computeReadiness(
  funded: boolean,
  trustline: boolean,
  xlm_balance: string,
  options: ReadinessOptions = {}
): ReadinessStatus {
  const { minimumBalance = MIN_XLM_BALANCE, authorized = true, spendableBalance } = options;
  const balance = parseXlmBalance(
    spendableBalance !== undefined ? spendableBalance : xlm_balance
  );

  // A present-but-unauthorized trustline still fails payments.
  if (funded && trustline && !authorized) return "not_ready";

  if (funded && trustline && balance < minimumBalance) {
    return "low_reserve";
  }
  if (funded && trustline) return "ready";

  return "not_ready";
}

/** On-chain verified: funded, trustline present, and issuer-authorized. */
export function computeVerified(
  funded: boolean,
  trustline: boolean,
  authorized: boolean
): boolean {
  return funded && trustline && authorized;
}

export function buildCheckResult(
  funded: boolean,
  trustline: boolean,
  xlm_balance: string,
  errors: string[] = [],
  trustlineAuthorized: boolean = trustline,
  spendableXlmBalance?: string,
  usdcBalance?: string,
  horizonLatencyMs?: number
): HorizonCheckResult {
  const balance = String(xlm_balance ?? "0");
  const spendableBalance =
    spendableXlmBalance !== undefined ? String(spendableXlmBalance) : balance;
  const assetBalance = String(usdcBalance ?? "0");
  return {
    funded,
    trustline,
    trustline_authorized: trustlineAuthorized,
    verified: computeVerified(funded, trustline, trustlineAuthorized),
    xlm_balance: balance,
    spendable_xlm_balance: spendableBalance,
    usdc_balance: assetBalance,
    horizon_latency_ms: horizonLatencyMs,
    errors,
    readiness: computeReadiness(funded, trustline, balance, {
      authorized: trustlineAuthorized,
      spendableBalance,
    }),
  };
}

export function getReadinessTone(
  status: ReadinessStatus
): "success" | "warning" | "danger" {
  if (status === "ready") return "success";
  if (status === "low_reserve") return "warning";
  return "danger";
}

export function getHorizonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Horizon error";
}

export function isAccountNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return message.includes("404") || normalized.includes("not found");
}

export function buildNotFoundCheckResult(): HorizonCheckResult {
  return buildCheckResult(false, false, "0", [
    "Account not found on the Stellar network (not funded)",
  ]);
}

/**
 * Contributor-facing copy for each readiness state.
 *
 * Written for someone whose first contact with Stellar is this page: say what
 * the state means for their payout, then what to do about it. The Horizon
 * field names, balances, and reason codes behind the state belong in the
 * maintainer "Horizon debug" panel (`ContributorDebugPanel`), not here.
 *
 * Keep in step with `docs/READINESS_MODEL.md` and `WIZARD_ACTION_COPY`.
 */
export const READINESS_CONFIG: Record<ReadinessStatus, ReadinessDisplayConfig> = {
  ready: {
    label: "Ready",
    variant: "ready",
    icon: "✅",
    description: "This wallet is set up and can receive USDC payouts.",
    nextStep: "Nothing to do — you are set for the next payout.",
    reasonCodes: ["none"],
  },
  low_reserve: {
    label: "Low balance",
    variant: "warning",
    icon: "⚠️",
    description:
      "This wallet can receive USDC, but it is running low on XLM — the small deposit Stellar keeps locked in every wallet.",
    nextStep:
      "Add a little more XLM so the wallet keeps working when the payout lands.",
    reasonCodes: ["increase_reserve"],
  },
  not_ready: {
    label: "Not ready yet",
    variant: "danger",
    icon: "❌",
    description: "This wallet cannot receive USDC payouts yet.",
    nextStep:
      "Follow the setup steps: put some XLM in the wallet, then turn on USDC for it.",
    reasonCodes: [
      "fund_account",
      "add_trustline",
      "await_trustline_authorization",
    ],
  },
};

export function getReadinessConfig(status: ReadinessStatus): ReadinessDisplayConfig {
  return READINESS_CONFIG[status];
}

export function getRowAccent(status: ReadinessStatus): string {
  switch (status) {
    case "ready":
      return "border-l-4 border-l-emerald-500";
    case "low_reserve":
      return "border-l-4 border-l-amber-500";
    case "not_ready":
      return "border-l-4 border-l-red-500";
  }
}

export function describeReadiness(status: ReadinessStatus): string {
  return getReadinessConfig(status).description;
}

/** Plain-language "what to do next" for a readiness state. */
export function getReadinessNextStep(status: ReadinessStatus): string {
  return getReadinessConfig(status).nextStep;
}

/**
 * Full badge copy: what the state means plus what to do about it. Used for the
 * badge tooltip and for the expanded guidance under the badge.
 */
export function describeReadinessWithNextStep(status: ReadinessStatus): string {
  const config = getReadinessConfig(status);
  return `${config.description} ${config.nextStep}`;
}

// ---------------------------------------------------------------------------
// Visual regression baselines (Issue #794)
// ---------------------------------------------------------------------------

export type VisualColorScheme = "light" | "dark";

export type VisualBaselineSurface = "readiness-panel" | "wave-status-banner";

export const VISUAL_BASELINE_REASON_CODES = {
  INVALID_SNAPSHOT_NAME: "INVALID_SNAPSHOT_NAME",
  DUPLICATE_SNAPSHOT_NAME: "DUPLICATE_SNAPSHOT_NAME",
  INVALID_TEST_ID: "INVALID_TEST_ID",
  INVALID_DIFF_THRESHOLD: "INVALID_DIFF_THRESHOLD",
  MISSING_COLOR_SCHEME_PAIR: "MISSING_COLOR_SCHEME_PAIR",
  MISSING_DOC_BASELINE: "MISSING_DOC_BASELINE",
  MISSING_SPEC_COVERAGE: "MISSING_SPEC_COVERAGE",
} as const;

export type VisualBaselineReasonCode =
  (typeof VISUAL_BASELINE_REASON_CODES)[keyof typeof VISUAL_BASELINE_REASON_CODES];

export interface VisualBaselineEntry {
  /** Stable logical group id shared by the light & dark snapshot pair. */
  groupId: string;
  /** Surface category covered by this baseline. */
  surface: VisualBaselineSurface;
  /** Snapshot filename expected under tests/e2e/visual.spec.ts-snapshots/. */
  snapshot: string;
  /** Emulated prefers-color-scheme value. */
  colorScheme: VisualColorScheme;
  /** Target element data-testid anchored in the dashboard UI. */
  testId: string;
  /** Human-readable description kept in sync with docs/VISUAL_REGRESSION.md. */
  description: string;
  /** Readiness statuses exercised by this snapshot (when surface === "readiness-panel"). */
  readinessStates?: ReadinessStatus[];
  /** Allowed Playwright maxDiffPixelRatio (0 < ratio <= 0.1). */
  maxDiffPixelRatio: number;
}

export interface VisualBaselineValidationIssue {
  code: VisualBaselineReasonCode;
  target: string;
  message: string;
}

export interface VisualBaselineValidationResult {
  ok: boolean;
  issues: VisualBaselineValidationIssue[];
}

const SNAPSHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{2,120}\.png$/;
const TEST_ID_RE = /^[a-z0-9][a-z0-9-]{1,80}$/;

/**
 * Canonical visual regression baselines for the dashboard Wave readiness panel
 * (`[data-testid="wave-readiness-panel"]`) in both light and dark modes.
 */
export const READINESS_VISUAL_BASELINES: readonly VisualBaselineEntry[] = [
  {
    groupId: "readiness-panel-all-states",
    surface: "readiness-panel",
    snapshot: "readiness-panel-all-states-light.png",
    colorScheme: "light",
    testId: "wave-readiness-panel",
    description:
      "Wave readiness panel showing mixed ready / low_reserve / not_ready progress — light",
    readinessStates: ["ready", "low_reserve", "not_ready"],
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "readiness-panel-all-states",
    surface: "readiness-panel",
    snapshot: "readiness-panel-all-states-dark.png",
    colorScheme: "dark",
    testId: "wave-readiness-panel",
    description:
      "Wave readiness panel showing mixed ready / low_reserve / not_ready progress — dark",
    readinessStates: ["ready", "low_reserve", "not_ready"],
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "readiness-panel-zero-empty",
    surface: "readiness-panel",
    snapshot: "readiness-panel-zero-empty-light.png",
    colorScheme: "light",
    testId: "wave-readiness-panel",
    description: "Wave readiness panel with 0/0 contributors (0% bar) — light",
    readinessStates: [],
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "readiness-panel-zero-empty",
    surface: "readiness-panel",
    snapshot: "readiness-panel-zero-empty-dark.png",
    colorScheme: "dark",
    testId: "wave-readiness-panel",
    description: "Wave readiness panel with 0/0 contributors (0% bar) — dark",
    readinessStates: [],
    maxDiffPixelRatio: 0.05,
  },
];

/**
 * Canonical visual regression baselines for dashboard Wave status banners
 * (freeze window and stale-data warning/critical banners) in light and dark modes.
 */
export const WAVE_STATUS_BANNER_BASELINES: readonly VisualBaselineEntry[] = [
  {
    groupId: "wave-status-banner-freeze",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-freeze-light.png",
    colorScheme: "light",
    testId: "freeze-window-banner",
    description: "Active Wave freeze window alert banner — light",
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "wave-status-banner-freeze",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-freeze-dark.png",
    colorScheme: "dark",
    testId: "freeze-window-banner",
    description: "Active Wave freeze window alert banner — dark",
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "wave-status-banner-stale-warning",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-stale-warning-light.png",
    colorScheme: "light",
    testId: "stale-data-banner",
    description: "Stale contributor data warning banner (<50% stale) — light",
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "wave-status-banner-stale-warning",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-stale-warning-dark.png",
    colorScheme: "dark",
    testId: "stale-data-banner",
    description: "Stale contributor data warning banner (<50% stale) — dark",
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "wave-status-banner-stale-critical",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-stale-critical-light.png",
    colorScheme: "light",
    testId: "stale-data-banner",
    description:
      "Stale contributor data critical banner (>=50% stale or never verified) — light",
    maxDiffPixelRatio: 0.05,
  },
  {
    groupId: "wave-status-banner-stale-critical",
    surface: "wave-status-banner",
    snapshot: "wave-status-banner-stale-critical-dark.png",
    colorScheme: "dark",
    testId: "stale-data-banner",
    description:
      "Stale contributor data critical banner (>=50% stale or never verified) — dark",
    maxDiffPixelRatio: 0.05,
  },
];

export const ALL_VISUAL_BASELINES: readonly VisualBaselineEntry[] = [
  ...READINESS_VISUAL_BASELINES,
  ...WAVE_STATUS_BANNER_BASELINES,
];

/**
 * Validate a visual baseline catalog: every snapshot name must be well-formed
 * and unique, every testId and diff threshold must be within bounds, and every
 * logical group must cover both `light` and `dark` color schemes.
 */
export function validateVisualBaselineCatalog(
  entries: readonly VisualBaselineEntry[]
): VisualBaselineValidationResult {
  const issues: VisualBaselineValidationIssue[] = [];
  const seenSnapshots = new Set<string>();
  const schemesByGroup = new Map<string, Set<VisualColorScheme>>();

  for (const entry of entries) {
    const snapshot = typeof entry.snapshot === "string" ? entry.snapshot.trim() : "";
    if (!SNAPSHOT_NAME_RE.test(snapshot)) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.INVALID_SNAPSHOT_NAME,
        target: snapshot || "(empty)",
        message: `Snapshot name "${snapshot}" must match ${SNAPSHOT_NAME_RE.source}`,
      });
    } else if (seenSnapshots.has(snapshot)) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.DUPLICATE_SNAPSHOT_NAME,
        target: snapshot,
        message: `Duplicate snapshot filename "${snapshot}"`,
      });
    } else {
      seenSnapshots.add(snapshot);
    }

    const testId = typeof entry.testId === "string" ? entry.testId.trim() : "";
    if (!TEST_ID_RE.test(testId)) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.INVALID_TEST_ID,
        target: testId || "(empty)",
        message: `Target data-testid "${testId}" must match ${TEST_ID_RE.source}`,
      });
    }

    if (
      typeof entry.maxDiffPixelRatio !== "number" ||
      !Number.isFinite(entry.maxDiffPixelRatio) ||
      entry.maxDiffPixelRatio <= 0 ||
      entry.maxDiffPixelRatio > 0.1
    ) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.INVALID_DIFF_THRESHOLD,
        target: snapshot || entry.groupId,
        message: `maxDiffPixelRatio must be a finite number in (0, 0.1], got ${String(entry.maxDiffPixelRatio)}`,
      });
    }

    const groupSchemes = schemesByGroup.get(entry.groupId) ?? new Set<VisualColorScheme>();
    groupSchemes.add(entry.colorScheme);
    schemesByGroup.set(entry.groupId, groupSchemes);
  }

  for (const [groupId, schemes] of schemesByGroup.entries()) {
    if (!schemes.has("light") || !schemes.has("dark")) {
      const missing = !schemes.has("light") ? "light" : "dark";
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.MISSING_COLOR_SCHEME_PAIR,
        target: groupId,
        message: `Baseline group "${groupId}" is missing its "${missing}" color scheme pair`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Cross-check the baseline catalog against `docs/VISUAL_REGRESSION.md` and
 * `tests/e2e/visual.spec.ts` so docs, specs, and readiness metadata never drift.
 */
export function verifyVisualBaselineDocsSync(
  entries: readonly VisualBaselineEntry[],
  visualRegressionDoc: string,
  visualSpecSource: string
): VisualBaselineValidationResult {
  const issues: VisualBaselineValidationIssue[] = [];

  const hasLightDarkLoop =
    visualSpecSource.includes('["light", "dark"]') ||
    visualSpecSource.includes("['light', 'dark']");

  for (const entry of entries) {
    if (!visualRegressionDoc.includes(entry.snapshot)) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.MISSING_DOC_BASELINE,
        target: entry.snapshot,
        message: `Baseline "${entry.snapshot}" is not documented in docs/VISUAL_REGRESSION.md`,
      });
    }
    const templatePattern = `${entry.groupId}-\${colorScheme}.png`;
    const hasSpecCoverage =
      visualSpecSource.includes(entry.snapshot) ||
      (hasLightDarkLoop && visualSpecSource.includes(templatePattern));
    if (!hasSpecCoverage) {
      issues.push({
        code: VISUAL_BASELINE_REASON_CODES.MISSING_SPEC_COVERAGE,
        target: entry.snapshot,
        message: `Baseline "${entry.snapshot}" is not asserted in tests/e2e/visual.spec.ts`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Stable reason codes surfaced by the readiness check and the register
 * recheck route. Documented in `docs/E2E_TESTING.md` and `docs/READINESS_MODEL.md`
 * so the E2E fail → fund/trustline → recheck-pass path can assert on them.
 */
export type ReadinessReasonCode =
  | "account_unfunded"
  | "account_no_trustline"
  | "account_trustline_unauthorized"
  | "account_low_balance"
  | "account_ready"
  | "horizon_rate_limited"
  | "horizon_error";

/**
 * Map a Horizon check result to a single stable reason code. The recheck route
 * returns this alongside `readiness` so E2E tests and the UI can branch on a
 * documented value instead of parsing free-form error strings.
 */
export function getReadinessReasonCode(
  result: HorizonCheckResult
): ReadinessReasonCode {
  if (result.readiness === "ready") return "account_ready";
  if (result.readiness === "low_reserve") return "account_low_balance";
  if (!result.funded) return "account_unfunded";
  if (!result.trustline) return "account_no_trustline";
  if (!result.trustline_authorized) return "account_trustline_unauthorized";
  return "account_unfunded";
}
