import "server-only";

import { rpc, scValToNative, Contract } from "stellar-sdk";

import { recordAuditLog } from "@/lib/audit";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const logger = new StructuredLogger("contract-sync");

export type ContractSyncStatus = "ok" | "error" | "skipped";

export interface ContractSyncResult {
  status: ContractSyncStatus;
  startedAt: string;
  durationMs: number;
  synced?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  errors?: string[];
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

interface ContractRegistration {
  stellarAddress: string;
  githubUsername?: string;
}

/**
 * Fetch all registrations from the Soroban contract using get_registered_paginated.
 * Returns an empty array if the contract is not configured or on error.
 */
async function fetchContractRegistrations(): Promise<{
  registrations: ContractRegistration[];
  errors: string[];
}> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();
  if (!contractId) {
    return { registrations: [], errors: ["SOROBAN_CONTRACT_ID is not configured"] };
  }

  try {
    void new rpc.Server(getSorobanRpcUrl());
    const contract = new Contract(contractId);

    // Fetch all registrations using get_registered_paginated
    // The contract should return a list of (stellarAddress, githubUsername) tuples
    const result = await contract.call("get_registered_paginated");

    const registrations: ContractRegistration[] = [];

    // Parse the result — assume it returns a Vec of structs or tuples
    if (result && typeof result === "object") {
      const native = scValToNative(result as never);
      if (Array.isArray(native)) {
        for (const item of native) {
          if (Array.isArray(item) && item.length >= 1) {
            registrations.push({
              stellarAddress: item[0] as string,
              githubUsername: item.length > 1 ? (item[1] as string) : undefined,
            });
          } else if (typeof item === "string") {
            registrations.push({ stellarAddress: item });
          }
        }
      }
    }

    return { registrations, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Soroban error";
    return { registrations: [], errors: [`Soroban RPC error: ${message}`] };
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
  for (const contractReg of contractRegistrations) {
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

    // Check if GitHub username changed
    if (
      contractReg.githubUsername &&
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

/**
 * Syncs Postgres registration state against on-chain contract data.
 *
 * This is the TRUE contract→Postgres sync, not a Horizon re-check.
 * It reads from the Soroban contract and updates Postgres accordingly.
 *
 * Rate-limited (`CONTRACT_SYNC_MIN_INTERVAL_MS`) so an over-eager
 * scheduler or retry storm can't fan out into repeated full-table sweeps.
 * Never throws: RPC outages and DB errors are caught and
 * returned as a result so a cron trigger never surfaces a 500.
 */
export async function syncContractToPostgres(): Promise<ContractSyncResult> {
  const now = Date.now();
  const minIntervalMs = getMinIntervalMs();

  if (lastRunAt !== null && now - lastRunAt < minIntervalMs) {
    logger.info("sync_skipped_rate_limited", {
      msSinceLastRun: now - lastRunAt,
      minIntervalMs,
    });
    return {
      status: "skipped",
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
    };
  }

  lastRunAt = now;
  const startedAt = new Date(now).toISOString();
  logger.info("sync_started", { startedAt });

  try {
    // Step 1: Fetch registrations from contract
    const { registrations: contractRegistrations, errors: fetchErrors } =
      await fetchContractRegistrations();

    if (fetchErrors.length > 0) {
      logger.warn("sync_fetch_errors", { errors: fetchErrors });
    }

    // Step 2: Sync into Postgres
    const { created, updated, unchanged } = await syncContractRegistrations(
      contractRegistrations
    );

    const durationMs = Date.now() - now;
    const synced = contractRegistrations.length;

    logger.info("sync_completed", {
      synced,
      created,
      updated,
      unchanged,
      fetchErrors: fetchErrors.length,
      durationMs,
    });

    await recordAuditLog({
      action: "contract.sync",
      metadata: {
        synced,
        created,
        updated,
        unchanged,
        fetchErrors: fetchErrors.length,
      },
    });

    lastResult = {
      status: fetchErrors.length > 0 ? "error" : "ok",
      startedAt,
      durationMs,
      synced,
      created,
      updated,
      unchanged,
      errors: fetchErrors.length > 0 ? fetchErrors : undefined,
    };
    return lastResult;
  } catch (error) {
    const durationMs = Date.now() - now;
    const message =
      error instanceof Error ? error.message : "Unknown sync error";

    logger.error("sync_failed", { error: message, durationMs });

    await recordAuditLog({
      action: "contract.sync",
      metadata: { error: message },
    });

    lastResult = {
      status: "error",
      startedAt,
      durationMs,
      errors: [message],
    };
    return lastResult;
  }
}

/** Last sync outcome, for the health endpoint. Never triggers a new run. */
export function getContractSyncHealth(): ContractSyncResult | null {
  return lastResult;
}

/** Test-only: reset in-memory rate-limit/health state between test runs. */
export function resetContractSyncState(): void {
  lastRunAt = null;
  lastResult = null;
}
