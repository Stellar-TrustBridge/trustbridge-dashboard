export type ReadinessStatus = "ready" | "low_reserve" | "not_ready";

export interface HorizonCheckResult {
  funded: boolean;
  trustline: boolean;
  /**
   * Whether the matching trustline is authorized by the asset issuer.
   * A present-but-unauthorized trustline still fails payments, so this is
   * tracked separately from `trustline` (mere presence).
   */
  trustline_authorized: boolean;
  /**
   * On-chain verified: funded, trustline present, and authorized.
   * Convenience flag derived from the checks above.
   */
  verified: boolean;
  xlm_balance: string;
  /**
   * Spendable XLM: raw balance minus the account's minimum reserve
   * (subentries/sponsorships) and any `selling_liabilities`. Used for the
   * reserve check instead of the raw balance — see `computeReadiness`.
   */
  spendable_xlm_balance: string;
  errors: string[];
  readiness: ReadinessStatus;
}

export interface CheckAddressPayload {
  address: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface ContributorRow {
  id: string;
  githubUsername: string;
  stellarAddress: string;
  trustlineReady: boolean;
  trustlineAuthorized: boolean;
  verified: boolean;
  funded: boolean;
  xlmBalance: string;
  spendableXlmBalance: string;
  lastCheckedAt: string | null;
  readiness: ReadinessStatus;
}

export type AuditAction =
  | "recheck.single"
  | "recheck.batch"
  | "registration.create"
  | "registration.update"
  | "network_config_mismatch_detected";

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorLogin: string | null;
  action: AuditAction | string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardStats {
  totalContributors: number;
  readyCount: number;
  readyPercent: number;
}

export type SorobanEventType = "contract" | "system" | "diagnostic";

export interface SorobanEventRow {
  id: string;
  type: SorobanEventType;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
  txHash: string;
}

export interface SorobanEventTimelineResponse {
  events: SorobanEventRow[];
  latestLedger: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Onboarding checklist
// ---------------------------------------------------------------------------

/**
 * Canonical keys that the onboarding checklist tracks.
 * Add new steps here; the reducer and API route stay in sync automatically.
 */
export type OnboardingChecklistKey =
  | "stellarAccountCreated"
  | "usdcTrustlineAdded"
  | "addressRegistered"
  | "readinessConfirmed";

/**
 * Maps each checklist step to a completion boolean.
 * Unknown keys from the server are ignored at the UI layer; partial updates
 * must not wipe steps that are already completed.
 *
 * Initialise as `{}` (all steps pending) and merge incoming PATCH payloads
 * with `{ ...existing, ...incoming }` so completed steps are never cleared.
 */
export type OnboardingChecklistState = Partial<
  Record<OnboardingChecklistKey, boolean>
>;

export type StellarNetwork = "mainnet" | "testnet" | "custom";

export interface NetworkConfig {
  horizonUrl: string;
  horizonNetwork: StellarNetwork;
  sorobanUrl: string;
  sorobanNetwork: StellarNetwork;
  sorobanContractConfigured: boolean;
  mismatched: boolean;
  warnings: string[];
}
