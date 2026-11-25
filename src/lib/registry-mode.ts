export type RegistryMode = "live" | "synced";

export const VALID_REGISTRY_MODES: readonly RegistryMode[] = ["live", "synced"];

const VALID_MODES = new Set<RegistryMode>(VALID_REGISTRY_MODES);

/**
 * Pure parser for `REGISTRY_MODE`. Normalizes case/whitespace and falls back
 * to `"live"` for unset or unrecognized values so read routes never break.
 */
export function parseRegistryMode(raw?: string | null): RegistryMode {
  const normalized = raw?.trim().toLowerCase();
  return normalized && VALID_MODES.has(normalized as RegistryMode)
    ? (normalized as RegistryMode)
    : "live";
}

/**
 * Returns `true` when the registry mode is contract-backed (`"synced"`),
 * meaning outbox worker and Soroban contract configuration are required for
 * Wave on-chain registration and sync.
 */
export function isContractBackedRegistryMode(
  mode: RegistryMode = getRegistryMode()
): boolean {
  return mode === "synced";
}

/**
 * Resolves the dashboard's registry mode, shared by every contributor-facing
 * REST endpoint instead of each route re-deriving it independently:
 *
 * - `"live"` (default): reads reflect whatever is currently persisted, and
 *   maintainers are expected to trigger a Horizon recheck (`POST
 *   /api/contributors`, `/api/contributors/[id]`) to refresh it.
 * - `"synced"`: signals that a scheduled contract-to-Postgres sync job
 *   (`src/lib/contract-sync.ts`) and Soroban outbox worker are responsible for
 *   keeping registration rows fresh and mirrored on-chain, so read endpoints
 *   can trust Postgres without prompting a maintainer to manually recheck.
 *
 * Reads are identical in both modes (Postgres is always the source of
 * truth) — the mode only changes what a route reports about how fresh that
 * data is expected to be. An unrecognized value falls back to `"live"`
 * rather than failing closed, so a typo'd env var never breaks reads.
 */
export function getRegistryMode(): RegistryMode {
  return parseRegistryMode(process.env.REGISTRY_MODE);
}
