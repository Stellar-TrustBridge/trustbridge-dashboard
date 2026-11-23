export type RegistryMode = "live" | "synced" | "contract";

const VALID_MODES = new Set<RegistryMode>(["live", "synced", "contract"]);

/**
 * Stable reason codes emitted when contract mode is only half-configured.
 * Callers (boot checks, request handlers, tests) can assert on these instead
 * of parsing human-readable messages.
 */
export type RegistryModeReasonCode =
  | "REGISTRY_MODE_CONTRACT_MISSING_RPC"
  | "REGISTRY_MODE_CONTRACT_MISSING_CONTRACT_ID"
  | "REGISTRY_MODE_CONTRACT_MISSING_RPC_AND_CONTRACT_ID";

/**
 * Result of resolving the registry mode. `ready` is `false` only when
 * contract mode is selected but its required configuration is incomplete —
 * in that case the caller must fail closed (refuse to boot / reject the
 * request) rather than silently proceeding with a half-configured registry.
 */
export type RegistryModeResult =
  | { mode: RegistryMode; ready: true }
  | {
      mode: "contract";
      ready: false;
      reasonCode: RegistryModeReasonCode;
      message: string;
    };

/**
 * Resolves the dashboard's registry mode, shared by every contributor-facing
 * REST endpoint instead of each route re-deriving it independently:
 *
 * - `"live"` (default): reads reflect whatever is currently persisted, and
 *   maintainers are expected to trigger a Horizon recheck (`POST
 *   /api/contributors`, `/api/contributors/[id]`) to refresh it.
 * - `"synced"`: signals that a scheduled contract-to-Postgres sync job
 *   (`src/lib/contract-sync.ts`) is responsible for keeping registration
 *   rows fresh, so read endpoints can trust Postgres without prompting a
 *   maintainer to manually recheck.
 * - `"contract"`: reads are backed by an on-chain registry contract. This
 *   mode requires both `REGISTRY_CONTRACT_RPC_URL` and
 *   `REGISTRY_CONTRACT_ID`; if either is missing the mode fails closed with
 *   a stable reason code instead of silently degrading.
 *
 * Reads are identical in both modes (Postgres is always the source of
 * truth) — the mode only changes what a route reports about how fresh that
 * data is expected to be. An unrecognized value falls back to `"live"`
 * rather than failing closed, so a typo'd env var never breaks reads.
 */
export function resolveRegistryMode(): RegistryModeResult {
  const raw = process.env.REGISTRY_MODE?.trim().toLowerCase();
  const mode: RegistryMode =
    raw && VALID_MODES.has(raw as RegistryMode)
      ? (raw as RegistryMode)
      : "live";

  if (mode !== "contract") {
    return { mode, ready: true };
  }

  const rpcUrl = process.env.REGISTRY_CONTRACT_RPC_URL?.trim();
  const contractId = process.env.REGISTRY_CONTRACT_ID?.trim();

  if (!rpcUrl && !contractId) {
    return {
      mode: "contract",
      ready: false,
      reasonCode: "REGISTRY_MODE_CONTRACT_MISSING_RPC_AND_CONTRACT_ID",
      message:
        "REGISTRY_MODE=contract requires REGISTRY_CONTRACT_RPC_URL and REGISTRY_CONTRACT_ID; both are missing.",
    };
  }

  if (!rpcUrl) {
    return {
      mode: "contract",
      ready: false,
      reasonCode: "REGISTRY_MODE_CONTRACT_MISSING_RPC",
      message:
        "REGISTRY_MODE=contract requires REGISTRY_CONTRACT_RPC_URL; it is missing.",
    };
  }

  if (!contractId) {
    return {
      mode: "contract",
      ready: false,
      reasonCode: "REGISTRY_MODE_CONTRACT_MISSING_CONTRACT_ID",
      message:
        "REGISTRY_MODE=contract requires REGISTRY_CONTRACT_ID; it is missing.",
    };
  }

  return { mode: "contract", ready: true };
}

/**
 * Convenience wrapper returning just the resolved mode. Throws when contract
 * mode is half-configured so callers fail closed at boot/request time rather
 * than proceeding with an incomplete registry configuration.
 */
export function getRegistryMode(): RegistryMode {
  const result = resolveRegistryMode();
  if (!result.ready) {
    throw new Error(`${result.reasonCode}: ${result.message}`);
  }
  return result.mode;
}
