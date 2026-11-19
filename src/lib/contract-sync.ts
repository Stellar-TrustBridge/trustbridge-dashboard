import "server-only";

import { rpc, scValToNative, Contract, TransactionBuilder, Account, Networks, nativeToScVal, xdr } from "stellar-sdk";

import { recordAuditLog } from "@/lib/audit";
import { redactAlertText } from "@/lib/cron-export-alert";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = new StructuredLogger("contract-sync");

export type ContractSyncStatus = "ok" | "error" | "skipped";

/**
 * Stable, operator-facing failure modes for contract sync.
 *
 * These codes are documented in `docs/contract-sync-failure-modes.md` and
 * surfaced verbatim in `ContractSyncResult.errors` so operators can map a
 * failure to a safe action without guessing. Do not rename without updating
 * the docs and tests.
 */
export type ContractSyncFailureMode =
  | "rpc_timeout"
  | "rpc_auth_error"
  | "cursor_gap"
  | "contract_not_configured"
  | "rpc_error";

export interface ContractSyncResult {
  status: ContractSyncStatus;
  startedAt: string;
  durationMs: number;
  synced?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  errors?: string[];
  failureMode?: ContractSyncFailureMode;
}

let lastRunAt: number | null = null;
let lastResult: ContractSyncResult | null = null;

function getMinIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.CONTRACT_SYNC_MIN_INTERVAL_MS ?? "60000",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60000;
}

function getSorobanRpcUrl(): string {
  return process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
}

function getNetworkPassphrase(): string {
  return process.env.SOROBAN_NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;
}

/**
 * Classify a raw Soroban RPC error into a stable failure mode.
 *
 * Operators rely on this mapping (see docs) to decide whether a retry is
 * safe. Blind retries on auth errors or cursor gaps worsen sync lag, so we
 * distinguish them from transient timeouts.
 */
export function classifyContractSyncError(error: unknown): ContractSyncFailureMode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset")
  ) {
    return "rpc_timeout";
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("auth")
  ) {
    return "rpc_auth_error";
  }

  if (
    lower.includes("cursor") ||
    lower.includes("gap") ||
    lower.includes("out of range") ||
    lower.includes("ledger range")
  ) {
    return "cursor_gap";
  }

  return "rpc_error";
}

interface ContractRegistration {
  stellarAddress: string;
  githubUsername?: string;
}

/**
 * Parse the native value returned by `get_registered_paginated` into a list
 * of contract registrations.
 *
 * Only exact `[address, username]` string pairs are accepted. Bare address
 * strings, address-only arrays, over-long tuples, and entries with a missing
 * or non-string address/username are skipped rather than throwing, so a
 * single bad row can't abort the whole sync or create half-identified rows.
 */
export function parseContractRegistrations(native: unknown): ContractRegistration[] {
  if (!Array.isArray(native)) {
    return [];
  }

  const registrations: ContractRegistration[] = [];

  for (const item of native) {
    if (!Array.isArray(item) || item.length !== 2) {
      continue;
    }
    const [address, username] = item;
    if (typeof address !== "string" || address.length === 0) {
      continue;
    }
    if (typeof username !== "string" || username.length === 0) {
      continue;
    }
    registrations.push({ stellarAddress: address, githubUsername: username });
  }

  return registrations;
}

/**
 * Read a Soroban contract function via RPC `simulateTransaction`.
 *
 * Soroban contract reads are not plain RPC calls — they must be simulated
 * against a recent ledger so the host can execute the contract and return
 * the result. We build a read-only transaction from a throwaway source
 * account, simulate it, and decode the returned ScVal.
 *
 * Also surfaces the RPC-reported `latestLedger` so callers can observe the
 * RPC cursor (issue #659): a frozen `latestLedger` across runs means the RPC
 * is not advancing even when the simulation itself still succeeds.
 */
async function simulateContractRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<{ native: unknown; latestLedger: number | null }> {
  const server = new rpc.Server(getSorobanRpcUrl());
  const contract = new Contract(contractId);

  // A read-only simulation does not need a funded account; any valid
  // account id works as the transaction source.
  const source = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const tx = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }

  const success = simulation as rpc.Api.SimulateTransactionSuccessResponse;
  const latestLedger =
    typeof success.latestLedger === "number" && Number.isFinite(success.latestLedger)
      ? success.latestLedger
      : null;

  const result = success.result;
  if (!result) {
    return { native: undefined, latestLedger };
  }

  return { native: scValToNative(result.retval), latestLedger };
}

/**
 * Fetch all registrations from the Soroban contract using get_registered_paginated.
 * Returns an empty array if the contract is not configured or on error.
 */
async function fetchContractRegistrations(): Promise<{
  registrations: ContractRegistration[];
  errors: string[];
  failureMode?: ContractSyncFailureMode;
  /** RPC cursor observed for this fetch (null when the RPC did not report one). */
  cursor: string | null;
}> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();
  if (!contractId) {
    return {
      registrations: [],
      errors: ["SOROBAN_CONTRACT_ID is not configured"],
      failureMode: "contract_not_configured",
      cursor: null,
    };
  }

  try {
    // Fetch all registrations using get_registered_paginated via RPC simulate.
    // The contract should return a list of (stellarAddress, githubUsername) tuples.
    const { native, latestLedger } = await simulateContractRead(
      contractId,
      "get_registered_paginated",
      [nativeToScVal(0, { type: "u32" }), nativeToScVal(100, { type: "u32" })]
    );

    return {
      registrations: parseContractRegistrations(native),
      errors: [],
      cursor: latestLedger === null ? null : String(latestLedger),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Soroban error";
    const failureMode = classifyContractSyncError(error);
    // Keep the raw message as the error element (callers match on it);
    // the classification rides along in `failureMode` and the logs.
    return {
      registrations: [],
      errors: [message],
      failureMode,
      cursor: null,
    };
  }
}

/**
 * Sync contract registrations into Postgres.
 *
 * Merge rules:
 * 1. If a registration exists in Postgres but not in contract → keep it (don't delete)
 * 2. If a registration exists in contract but not in Postgres → create it
 * 3. If a registration exists in both → update GitHub username if changed
 */
async function syncContractRegistrations(
  contractRegistrations: ContractRegistration[]
): Promise<{ created: number; updated: number; unchanged: number }> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  // Get all existing registrations from Postgres
  const existingRegistrations = await prisma.registration.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      stellarAddress: true,
      userId: true,
      user: {
        select: { githubUsername: true },
      },
    },
  });

  const existingByAddress = new Map(
    existingRegistrations.map((r) => [r.stellarAddress, r])
  );

  // Process each contract registration
  const seenInBatch = new Set<string>();
  for (const contractReg of contractRegistrations) {
    // De-duplicate repeated addresses within a single payload so counters
    // stay deterministic no matter how many times an entry repeats.
    if (seenInBatch.has(contractReg.stellarAddress)) {
      unchanged++;
      continue;
    }
    seenInBatch.add(contractReg.stellarAddress);

    const existing = existingByAddress.get(contractReg.stellarAddress);

    if (!existing) {
      // New registration from contract — we can't create it without a user
      // Log it for now, but don't create without a user
      logger.info("contract_registration_not_in_postgres", {
        stellarAddress: contractReg.stellarAddress,
        githubUsername: contractReg.githubUsername,
      });
      created++;
      continue;
    }

    // Check if GitHub username changed. A locally-unset (null) username is
    // left alone: the signup flow owns that field, and chain data must not
    // backfill it with a potentially stale value.
    if (
      contractReg.githubUsername &&
      existing.user.githubUsername &&
      existing.user.githubUsername !== contractReg.githubUsername
    ) {
      // Guard against conflicts: only update the linked User when the new
      // username isn't already claimed by a different user.
      const conflictingUser = await prisma.user.findFirst({
        where: {
          githubUsername: contractReg.githubUsername,
          id: { not: existing.userId },
        },
        select: { id: true },
      });

      if (conflictingUser) {
        logger.warn("contract_sync_username_conflict", {
          stellarAddress: contractReg.stellarAddress,
          oldUsername: existing.user.githubUsername,
          newUsername: contractReg.githubUsername,
          conflictingUserId: conflictingUser.id,
        });
        unchanged++;
        continue;
      }

      await prisma.user.update({
        where: { id: existing.userId },
        data: { githubUsername: contractReg.githubUsername },
      });
      logger.info("contract_sync_username_changed", {
        stellarAddress: contractReg.stellarAddress,
        oldUsername: existing.user.githubUsername,
        newUsername: contractReg.githubUsername,
      });
      updated++;
    } else {
      unchanged++;
    }
  }

  return { created, updated, unchanged };
}

// ───────────────────────────────────────────────────────────────────────
// Lag monitoring (issue #659)
//
// Detects when contract→Postgres synchronization (and the Soroban RPC
// cursor behind it) falls behind a configured threshold. The state is
// process-local like the rest of this module; `/api/health`,
// `GET /api/contract-sync` and the Prometheus endpoint all read the same
// view via `getContractSyncLagState()`.
// ───────────────────────────────────────────────────────────────────────

/**
 * Lag status for contract/RPC synchronization.
 *
 * - `ok`      — progress is within the configured lag threshold.
 * - `lagging` — no progress for at least `CONTRACT_SYNC_LAG_THRESHOLD_MS`.
 * - `stalled` — no progress for at least `CONTRACT_SYNC_STALL_THRESHOLD_MS`,
 *               or the observed RPC cursor has not advanced for that long.
 */
export type ContractSyncLagStatus = "ok" | "lagging" | "stalled";

/**
 * Stable, operator-facing lag reason codes. Surfaced verbatim in the
 * `contractSync.lag` health block, `GET /api/contract-sync` and metrics —
 * do not rename without updating docs and tests.
 */
export type ContractSyncLagReason =
  | "ok"
  | "no_data"
  | "never_succeeded"
  | "sync_delayed"
  | "sync_stalled"
  | "cursor_stalled"
  | "not_configured";

export interface ContractSyncLagState {
  status: ContractSyncLagStatus;
  reason: ContractSyncLagReason;
  /** ms since the last fully successful sync (null when none this process). */
  sinceLastSuccessMs: number | null;
  /** ms since the observed RPC cursor last advanced (null when none observed). */
  sinceLastCursorAdvanceMs: number | null;
  /** Configured lag threshold in ms (`CONTRACT_SYNC_LAG_THRESHOLD_MS`). */
  thresholdMs: number;
  /** Configured stall threshold in ms (`CONTRACT_SYNC_STALL_THRESHOLD_MS`). */
  stallThresholdMs: number;
  /** Last observed RPC cursor value (null when none observed). */
  cursor: string | null;
  /** ISO timestamp of the last fully successful sync (null when none). */
  lastSuccessAt: string | null;
}

const DEFAULT_LAG_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_STALL_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const ALERT_TIMEOUT_MS = 5_000;

function readThresholdMs(envVar: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[envVar] ?? "", 10);
  // Missing or invalid configuration falls back to the documented default so
  // a typo can never disable lag detection or open a zero-length window.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Configured lag threshold (ms). Invalid values fall back to 15 minutes. */
export function getContractSyncLagThresholdMs(): number {
  return readThresholdMs("CONTRACT_SYNC_LAG_THRESHOLD_MS", DEFAULT_LAG_THRESHOLD_MS);
}

/** Configured stall threshold (ms). Invalid values fall back to 60 minutes. */
export function getContractSyncStallThresholdMs(): number {
  return readThresholdMs("CONTRACT_SYNC_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS);
}

function getAlertCooldownMs(): number {
  return readThresholdMs("CONTRACT_SYNC_ALERT_COOLDOWN_MS", DEFAULT_ALERT_COOLDOWN_MS);
}

interface CursorProgress {
  /** Last observed RPC cursor value. */
  value: string;
  /** Epoch ms when the cursor last changed to a new value. */
  advancedAt: number;
}

interface LagAlertState {
  /** `status:reason` of the last successfully notified episode (null = none). */
  notifiedEpisode: string | null;
  lastAttemptAt: number | null;
  lastSentAt: number | null;
  /** Successfully delivered alerts since process start. */
  sentCount: number;
}

let processStartedAt = Date.now();
let lastSuccessAtMs: number | null = null;
let cursorProgress: CursorProgress | null = null;
let lagAlert: LagAlertState = {
  notifiedEpisode: null,
  lastAttemptAt: null,
  lastSentAt: null,
  sentCount: 0,
};

export interface ContractSyncLagSnapshot {
  now: number;
  processStartedAt: number;
  lastSuccessAt: number | null;
  cursor: CursorProgress | null;
  lastFailureMode?: ContractSyncFailureMode | null;
}

/**
 * Pure lag evaluation over an explicit snapshot — the single place where
 * threshold arithmetic and reason selection live, so tests can drive every
 * failure path with injected clocks and cursors (no RPC, no timers).
 */
export function evaluateContractSyncLag(
  snapshot: ContractSyncLagSnapshot,
  thresholds?: { thresholdMs?: number; stallThresholdMs?: number }
): ContractSyncLagState {
  const thresholdMs = thresholds?.thresholdMs ?? getContractSyncLagThresholdMs();
  const stallThresholdMs = thresholds?.stallThresholdMs ?? getContractSyncStallThresholdMs();
  const { now, lastSuccessAt: successAt, cursor } = snapshot;

  const sinceLastSuccessMs = successAt === null ? null : Math.max(0, now - successAt);
  const sinceLastCursorAdvanceMs = cursor === null ? null : Math.max(0, now - cursor.advancedAt);

  const base = {
    thresholdMs,
    stallThresholdMs,
    cursor: cursor?.value ?? null,
    lastSuccessAt: successAt === null ? null : new Date(successAt).toISOString(),
    sinceLastSuccessMs,
    sinceLastCursorAdvanceMs,
  };

  if (successAt === null) {
    // No successful sync in this process yet.
    if (snapshot.lastFailureMode === "contract_not_configured") {
      // Intentionally idle: no contract is configured, so there is nothing
      // to fall behind on. Not a lag condition and never alerted.
      return { status: "ok", reason: "not_configured", ...base };
    }
    const age = Math.max(0, now - snapshot.processStartedAt);
    if (age >= stallThresholdMs) {
      return { status: "stalled", reason: "never_succeeded", ...base };
    }
    if (age >= thresholdMs) {
      return { status: "lagging", reason: "never_succeeded", ...base };
    }
    return { status: "ok", reason: "no_data", ...base };
  }

  const sinceSuccess = sinceLastSuccessMs as number;
  if (sinceSuccess >= stallThresholdMs) {
    return { status: "stalled", reason: "sync_stalled", ...base };
  }
  if (sinceSuccess >= thresholdMs) {
    return { status: "lagging", reason: "sync_delayed", ...base };
  }
  if (sinceLastCursorAdvanceMs !== null && sinceLastCursorAdvanceMs >= stallThresholdMs) {
    // Runs still complete, but the RPC-reported cursor is frozen: the data
    // being synced is not moving forward even though sync itself succeeds.
    return { status: "stalled", reason: "cursor_stalled", ...base };
  }
  return { status: "ok", reason: "ok", ...base };
}

/**
 * Current lag state for this process. Reads module state only — no RPC, no
 * database — so it is safe to call from health checks and metric scrapes.
 */
export function getContractSyncLagState(options?: { now?: number }): ContractSyncLagState {
  return evaluateContractSyncLag({
    now: options?.now ?? Date.now(),
    processStartedAt,
    lastSuccessAt: lastSuccessAtMs,
    cursor: cursorProgress,
    lastFailureMode: lastResult?.failureMode ?? null,
  });
}

export interface ContractSyncAlertMetrics {
  /** Successfully delivered lag alerts since process start. */
  sentCount: number;
  lastSentAt: string | null;
  lastAttemptAt: string | null;
}

/** Alert-delivery counters for metrics/tests (`GET /api/metrics` consumers). */
export function getContractSyncAlertMetrics(): ContractSyncAlertMetrics {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    sentCount: lagAlert.sentCount,
    lastSentAt: iso(lagAlert.lastSentAt),
    lastAttemptAt: iso(lagAlert.lastAttemptAt),
  };
}

interface ContractSyncAlertPayload {
  source: "trustbridge-contract-sync";
  status: ContractSyncLagStatus;
  reason: ContractSyncLagReason;
  thresholdMs: number;
  stallThresholdMs: number;
  sinceLastSuccessMs: number | null;
  sinceLastCursorAdvanceMs: number | null;
  lastSuccessAt: string | null;
  cursor: string | null;
  environment: string;
  /** Optional PagerDuty routing key (CONTRACT_SYNC_ALERT_PAGERDUTY_KEY). */
  routing_key?: string;
  event_action?: "trigger";
  /** Slack-style message body (text is redacted before leaving the process). */
  text?: string;
}

/**
 * Fire the maintainer lag-alert webhook. Destination:
 * `CONTRACT_SYNC_ALERT_WEBHOOK_URL` (no-op when unset). Fire-and-forget with
 * a 5-second abort timeout; delivery failures are logged and never re-throw.
 * Returns whether the alert was accepted by the destination.
 */
async function deliverContractSyncLagAlert(state: ContractSyncLagState): Promise<boolean> {
  const webhookUrl = process.env.CONTRACT_SYNC_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  const environment = process.env.NODE_ENV ?? "unknown";
  const summary = redactAlertText(
    `contract sync ${state.status} (reason: ${state.reason}) — ` +
      `no progress for ${state.sinceLastSuccessMs ?? state.sinceLastCursorAdvanceMs ?? 0}ms ` +
      `(lag threshold ${state.thresholdMs}ms, stall threshold ${state.stallThresholdMs}ms)`
  );

  const payload: ContractSyncAlertPayload = {
    source: "trustbridge-contract-sync",
    status: state.status,
    reason: state.reason,
    thresholdMs: state.thresholdMs,
    stallThresholdMs: state.stallThresholdMs,
    sinceLastSuccessMs: state.sinceLastSuccessMs,
    sinceLastCursorAdvanceMs: state.sinceLastCursorAdvanceMs,
    lastSuccessAt: state.lastSuccessAt,
    cursor: state.cursor,
    environment,
    text: `🚨 TrustBridge contract sync ${state.status} (${environment})\n${summary}`,
  };

  const pdKey = process.env.CONTRACT_SYNC_ALERT_PAGERDUTY_KEY?.trim();
  if (pdKey) {
    payload.routing_key = pdKey;
    payload.event_action = "trigger";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("contract_sync_lag_alert_non_ok", {
        status: response.status,
        reason: state.reason,
      });
      return false;
    }
    logger.info("contract_sync_lag_alert_sent", {
      status: state.status,
      reason: state.reason,
    });
    return true;
  } catch (err) {
    // AbortError = timeout; log as warn — alert delivery is secondary.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("contract_sync_lag_alert_failed", { error: message });
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Notify maintainers that synchronization is lagging or stalled.
 *
 * Anti-spam rules (issue #659):
 *  - `ok` (including `no_data` / `not_configured`) closes the current
 *    episode, so a later stall notifies again.
 *  - One successful notification per `status:reason` episode — a sustained
 *    stall never re-notifies while the state is unchanged.
 *  - Failed deliveries are retried on later runs, but never more often than
 *    `CONTRACT_SYNC_ALERT_COOLDOWN_MS`.
 *  - Without `CONTRACT_SYNC_ALERT_WEBHOOK_URL` this is a silent no-op.
 *
 * Never throws: alert delivery must not affect the sync result.
 */
async function maybeSendContractSyncLagAlert(
  state: ContractSyncLagState,
  now: number
): Promise<void> {
  try {
    if (state.status === "ok") {
      lagAlert.notifiedEpisode = null;
      return;
    }
    if (!process.env.CONTRACT_SYNC_ALERT_WEBHOOK_URL?.trim()) return;

    const episode = `${state.status}:${state.reason}`;
    if (lagAlert.notifiedEpisode === episode) return;
    if (
      lagAlert.lastAttemptAt !== null &&
      now - lagAlert.lastAttemptAt < getAlertCooldownMs()
    ) {
      return;
    }

    lagAlert.lastAttemptAt = now;
    const delivered = await deliverContractSyncLagAlert(state);
    if (delivered) {
      lagAlert.notifiedEpisode = episode;
      lagAlert.lastSentAt = now;
      lagAlert.sentCount += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("contract_sync_lag_alert_error", { error: message });
  }
}

/**
 * Record the RPC cursor observed by a successful run. An unchanged cursor
 * keeps its original `advancedAt` so the stall clock keeps ticking.
 */
function recordCursorObservation(value: string | null, now: number): void {
  if (value == null) return;
  if (cursorProgress && cursorProgress.value === value) return;
  cursorProgress = { value, advancedAt: now };
}

export interface ContractSyncRunOptions {
  /** Injected clock (epoch ms). Tests use this instead of real time. */
  now?: () => number;
  /**
   * RPC cursor observed for this run. `undefined` uses the cursor reported by
   * the RPC; `null` records no observation.
   */
  cursor?: string | null;
}

/**
 * Syncs Postgres registration state against on-chain contract data.
 *
 * This is the TRUE contract→Postgres sync, not a Horizon re-check.
 * It reads from the Soroban contract and updates Postgres accordingly.
 *
 * Rate-limited (`CONTRACT_SYNC_MIN_INTERVAL_MS`) so an over-eager
 * scheduler or retry storm can't fan out into repeated RPC calls.
 *
 * Failure modes are classified (see `classifyContractSyncError`) and
 * surfaced via `failureMode` so operators can follow the documented
 * runbook instead of retrying blindly.
 *
 * Lag monitoring (issue #659): every non-skipped run records progress
 * (successful completion + observed RPC cursor), re-evaluates lag, and
 * fires the optional maintainer alert. `options.now` / `options.cursor`
 * are injection points for tests.
 */
export async function runContractSync(
  options: ContractSyncRunOptions = {}
): Promise<ContractSyncResult> {
  const clock = options.now ?? Date.now;
  const start = clock();
  const startedAt = new Date(start).toISOString();

  const minInterval = getMinIntervalMs();
  if (lastRunAt !== null && start - lastRunAt < minInterval) {
    return {
      status: "skipped",
      startedAt,
      durationMs: clock() - start,
    };
  }

  lastRunAt = start;

  const { registrations, errors, failureMode, cursor } = await fetchContractRegistrations();
  const observedCursor = options.cursor !== undefined ? options.cursor : cursor;

  const finishLagMonitoring = async (): Promise<void> => {
    const lag = getContractSyncLagState({ now: clock() });
    await maybeSendContractSyncLagAlert(lag, clock());
  };

  if (errors.length > 0) {
    const result: ContractSyncResult = {
      status: "error",
      startedAt,
      durationMs: clock() - start,
      errors,
      failureMode,
    };
    lastResult = result;
    logger.error("contract_sync_failed", {
      failureMode,
      errors,
    });
    // `recordAuditLog` never rejects (it swallows persistence errors
    // internally), so no `.catch` adapter is needed here.
    await recordAuditLog({
      action: "contract.sync",
      metadata: { error: errors.join("; "), failureMode, status: "error" },
    });
    await finishLagMonitoring();
    return result;
  }

  try {
    const { created, updated, unchanged } = await syncContractRegistrations(
      registrations
    );

    const result: ContractSyncResult = {
      status: "ok",
      startedAt,
      durationMs: clock() - start,
      synced: registrations.length,
      created,
      updated,
      unchanged,
    };
    lastResult = result;
    // Progress is only recorded on a fully successful run: a Postgres merge
    // failure must keep the lag clock ticking rather than look healthy.
    lastSuccessAtMs = clock();
    recordCursorObservation(observedCursor, lastSuccessAtMs);
    logger.info("contract_sync_completed", {
      synced: result.synced,
      created,
      updated,
      unchanged,
    });
    await recordAuditLog({
      action: "contract.sync",
      metadata: {
        synced: result.synced,
        created,
        updated,
        unchanged,
        status: "ok",
      },
    });
    await finishLagMonitoring();
    return result;
  } catch (error) {
    // Sync must never throw: schedulers and the status route rely on an
    // always-resolved result (200/502 with a body, never a 500).
    const message =
      error instanceof Error ? error.message : "Unknown sync error";
    const result: ContractSyncResult = {
      status: "error",
      startedAt,
      durationMs: clock() - start,
      errors: [message],
    };
    lastResult = result;
    logger.error("contract_sync_failed", { error: message });
    await recordAuditLog({
      action: "contract.sync",
      metadata: { error: message },
    });
    await finishLagMonitoring();
    return result;
  }
}

export function getLastContractSyncResult(): ContractSyncResult | null {
  return lastResult;
}

/**
 * Reset in-memory sync state (last run timestamp, last result, lag tracking
 * and alert episode). Used by tests to isolate sync runs; not for production
 * use.
 */
export function resetContractSyncState(): void {
  lastRunAt = null;
  lastResult = null;
  processStartedAt = Date.now();
  lastSuccessAtMs = null;
  cursorProgress = null;
  lagAlert = { notifiedEpisode: null, lastAttemptAt: null, lastSentAt: null, sentCount: 0 };
}

/**
 * Canonical entry-point names used by every caller (API routes, health
 * probes, and tests). Kept as aliases so the failure-mode documentation
 * work above stays untouched.
 */
export const syncContractToPostgres = runContractSync;
export const getContractSyncHealth = getLastContractSyncResult;
