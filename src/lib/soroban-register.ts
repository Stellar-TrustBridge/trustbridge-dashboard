import "server-only";

import type { Registration } from "@prisma/client";
import { rpc, Keypair, TransactionBuilder, Networks, Contract, Address, nativeToScVal } from "stellar-sdk";

/**
 * Result of attempting to mirror a registration to a Soroban contract.
 * Never throws — returns errors array instead for best-effort operation.
 */
export interface SorobanRegistrationResult {
  success: boolean;
  txHash?: string;
  errors: string[];
}

/**
 * Build the Soroban contract invocation to register a contributor.
 * Format: register(contributor: Address, github_username: Bytes)
 */
function buildRegisterArgs(stellarAddress: string, githubUsername: string) {
  return [
    new Address(stellarAddress).toScVal(),
    nativeToScVal(Buffer.from(githubUsername), { type: "bytes" }),
  ];
}

/**
 * Mirrors a registration to the configured Soroban contract (write-through).
 * Returns immediately with success/error status without blocking the HTTP response.
 *
 * Design principles:
 * - PostgreSQL stays the source of truth; this is a mirror, not the primary write
 * - Best-effort: outages, rate limits, or missing contract ID never fail the request
 * - Never throws: always returns a result with errors array on failure
 * - Non-blocking: async fire-and-forget pattern for background sync
 *
 * @param registration - The persisted Registration object to mirror
 * @param githubUsername - The GitHub username to associate with the registration
 * @returns Promise<SorobanRegistrationResult> with success flag and optional txHash or errors
 */
export async function mirrorRegistrationToSoroban(
  registration: Registration,
  githubUsername?: string
): Promise<SorobanRegistrationResult> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();
  const rpcUrl = process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const secretKey = process.env.SOROBAN_SECRET_KEY?.trim();

  // Missing contract ID is not an error state — registrations succeed with
  // SOROBAN_CONTRACT_ID unset, and the write is simply skipped.
  if (!contractId) {
    return {
      success: true, // "Success" in the sense that it doesn't block the request
      errors: [], // No error logged since the feature is optional
    };
  }

  // Missing secret key — log and skip without failing
  if (!secretKey) {
    return {
      success: false,
      errors: ["SOROBAN_SECRET_KEY is not configured — write-through skipped"],
    };
  }

  try {
    const server = new rpc.Server(rpcUrl);
    const sourceKeypair = Keypair.fromSecret(secretKey);
    const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

    const contract = new Contract(contractId);
    const username = githubUsername || registration.userId;

    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: "100", // 100 stroops base fee
      networkPassphrase: Networks.PUBLIC,
    });

    const tx = txBuilder
      .addOperation(contract.call("register", ...buildRegisterArgs(registration.stellarAddress, username)))
      .setTimeout(30)
      .build();

    tx.sign(sourceKeypair);

    const response = await server.sendTransaction(tx);

    if (response.status === "PENDING") {
      // Transaction submitted and awaiting confirmation
      // For best-effort, we return success with the hash
      return {
        success: true,
        txHash: response.hash,
        errors: [],
      };
    }

    if (response.status === "ERROR") {
      const errorResult = response.errorResult as
        | { result?: { codes?: unknown; name?: string } }
        | undefined;
      const errorType = errorResult?.result?.name;

      // Handle specific error cases
      if (errorType === "txFailed") {
        // Transaction failed on-chain (e.g. already registered)
        return {
          success: false,
          errors: [`Contract call failed: ${errorType}`],
        };
      }

      return {
        success: false,
        errors: [`Soroban RPC error: ${errorType || "unknown"}`],
      };
    }

    // Transaction successful
    return {
      success: true,
      txHash: response.hash,
      errors: [],
    };
  } catch (error) {
    // Catch and log the error without blocking the registration flow.
    const message =
      error instanceof Error ? error.message : "Unknown error writing to Soroban";

    // Don't fail the HTTP request — this is best-effort
    return {
      success: false,
      errors: [`Soroban write-through failed: ${message}`],
    };
  }
}

/**
 * Enqueue a registration write-through task into the Soroban outbox table.
 * Designed to be executed inside a Prisma $transaction alongside registration creation.
 */
export async function enqueueSorobanOutbox(
  db: any,
  action: string,
  payload: { stellarAddress: string; githubUsername: string; registrationId: string },
  maintainerOrgId = "default"
) {
  return db.sorobanOutbox.create({
    data: {
      maintainerOrgId,
      action,
      payload,
      status: "PENDING",
    },
  });
}
