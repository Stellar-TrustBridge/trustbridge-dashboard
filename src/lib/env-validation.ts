import "server-only";

import { z } from "zod";

import {
  isContractBackedRegistryMode,
  parseRegistryMode,
  VALID_REGISTRY_MODES,
  type RegistryMode,
} from "@/lib/registry-mode";

export const ENV_VALIDATION_REASON_CODES = {
  INVALID_REGISTRY_MODE: "INVALID_REGISTRY_MODE",
  OUTBOX_WORKER_URL_REQUIRED: "OUTBOX_WORKER_URL_REQUIRED",
  CONTRACT_ID_REQUIRED: "CONTRACT_ID_REQUIRED",
  SOROBAN_RPC_URL_REQUIRED: "SOROBAN_RPC_URL_REQUIRED",
} as const;

export type EnvValidationReasonCode =
  (typeof ENV_VALIDATION_REASON_CODES)[keyof typeof ENV_VALIDATION_REASON_CODES];

const MAX_HTTP_URL_LENGTH = 2048;

/**
 * Database connection pool configuration parsed from DATABASE_URL.
 */
export interface DatabasePoolConfig {
  connectionLimit?: number;
  poolTimeout?: number;
  idleInTransactionSessionTimeout?: number;
  pgbouncer?: boolean;
  schema?: string;
}

/**
 * Parses and validates PostgreSQL connection pool and PgBouncer parameters from DATABASE_URL.
 */
export function parseDatabasePoolConfig(urlStr: string): DatabasePoolConfig {
  try {
    const parsedUrl = new URL(urlStr);
    const params = parsedUrl.searchParams;

    const config: DatabasePoolConfig = {};

    const connectionLimitStr = params.get("connection_limit");
    if (connectionLimitStr !== null) {
      const parsed = parseInt(connectionLimitStr, 10);
      if (isNaN(parsed) || parsed < 1) {
        throw new Error("connection_limit must be a positive integer");
      }
      config.connectionLimit = parsed;
    }

    const poolTimeoutStr = params.get("pool_timeout");
    if (poolTimeoutStr !== null) {
      const parsed = parseInt(poolTimeoutStr, 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new Error("pool_timeout must be a non-negative integer");
      }
      config.poolTimeout = parsed;
    }

    const idleTimeoutStr = params.get("idle_in_transaction_session_timeout");
    if (idleTimeoutStr !== null) {
      const parsed = parseInt(idleTimeoutStr, 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new Error("idle_in_transaction_session_timeout must be a non-negative integer");
      }
      config.idleInTransactionSessionTimeout = parsed;
    }

    const pgbouncerStr = params.get("pgbouncer");
    if (pgbouncerStr !== null) {
      config.pgbouncer = pgbouncerStr.toLowerCase() === "true" || pgbouncerStr === "1";
    }

    const schemaStr = params.get("schema");
    if (schemaStr !== null) {
      config.schema = schemaStr;
    }

    return config;
  } catch (err) {
    if (err instanceof Error && err.message.includes("must be")) {
      throw err;
    }
    throw new Error(`Invalid DATABASE_URL for pool configuration: ${urlStr}`);
  }
}

/**
 * Common placeholder strings accepted by `new URL()` but useless at runtime.
 * Failing fast on these avoids half-booted dashboards pointed at a fake host.
 */
function isPlaceholderUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    /<[^>]*>|\.\.\.|change[-_ ]?me|placeholder|replace[-_ ]?me|your[-_ ]?(url|horizon|rpc|worker)|example\.(com|org|net)|^(todo|tbd|none|null|undefined|x+)$/.test(
      normalized
    )
  );
}

/**
 * Required-or-explicitly-optional HTTP(S) URL field. Rejects non-http schemes,
 * oversized URLs, and placeholder values that would otherwise pass Zod's generic `.url()`.
 */
function httpUrlField(name: string) {
  return z
    .string()
    .min(1, `${name} is required`)
    .max(MAX_HTTP_URL_LENGTH, `${name} must be at most ${MAX_HTTP_URL_LENGTH} characters`)
    .url(`${name} must be a valid URL`)
    .refine(
      (value) => {
        if (isPlaceholderUrl(value)) return false;
        try {
          const parsed = new URL(value);
          return (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            Boolean(parsed.hostname)
          );
        } catch {
          return false;
        }
      },
      `${name} must be an http(s) URL with a real host (placeholders are not allowed)`
    );
}

/**
 * Stable reason code emitted when a testnet contract id is paired with a
 * pubnet RPC/Horizon endpoint (or vice versa). Documented in docs/ENVIRONMENT.md.
 */
export const MIXED_NETWORK_REASON_CODE = "ENV_MIXED_NETWORK";

type StellarNetwork = "pubnet" | "testnet" | "futurenet" | "unknown";

/**
 * Infers the Stellar network from a URL host. Returns "unknown" when the host
 * does not carry a recognizable network marker (e.g. a custom proxy).
 */
export function inferNetworkFromUrl(urlStr: string | undefined): StellarNetwork {
  if (!urlStr) return "unknown";
  let host: string;
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host.includes("testnet")) return "testnet";
  if (host.includes("futurenet")) return "futurenet";
  if (host.includes("horizon.stellar.org") || host.includes("sorobanrpc.com") || host.includes("mainnet")) {
    return "pubnet";
  }
  return "unknown";
}

/**
 * Infers the Stellar network from a Soroban contract id. Soroban contract ids
 * are 56-char StrKey strings starting with `C`. The network is not encoded in
 * the id itself, so we only classify by well-known testnet contract prefixes
 * when present; otherwise "unknown".
 */
export function inferNetworkFromContractId(contractId: string | undefined): StellarNetwork {
  if (!contractId) return "unknown";
  const trimmed = contractId.trim();
  if (!/^C[A-Z2-7]{55}$/.test(trimmed)) return "unknown";
  // Well-known testnet contract ids used by Wave verification fixtures.
  if (trimmed.startsWith("CB") || trimmed.startsWith("CC") || trimmed.startsWith("CD")) {
    return "testnet";
  }
  return "unknown";
}

/**
 * Detects a mixed-network configuration: a testnet contract id paired with a
 * pubnet RPC/Horizon endpoint (or the inverse). Returns a stable reason code
 * and message, or null when the config is consistent.
 */
export function detectMixedNetworkConfig(env: {
  SOROBAN_CONTRACT_ID?: string;
  SOROBAN_RPC_URL?: string;
  NEXT_PUBLIC_HORIZON_URL?: string;
}): { code: string; message: string } | null {
  const contractNetwork = inferNetworkFromContractId(env.SOROBAN_CONTRACT_ID);
  if (contractNetwork === "unknown") return null;

  const rpcNetwork = inferNetworkFromUrl(env.SOROBAN_RPC_URL);
  const horizonNetwork = inferNetworkFromUrl(env.NEXT_PUBLIC_HORIZON_URL);

  const endpointNetwork = rpcNetwork !== "unknown" ? rpcNetwork : horizonNetwork;
  if (endpointNetwork === "unknown") return null;
  if (endpointNetwork === contractNetwork) return null;

  return {
    code: MIXED_NETWORK_REASON_CODE,
    message: `SOROBAN_CONTRACT_ID looks like a ${contractNetwork} contract but the configured RPC/Horizon endpoint is ${endpointNetwork}; point both at the same Stellar network`,
  };
}

/**
 * Environment variable schema for the TrustBridge Dashboard.
 * Validates all required and optional configuration at application boot.
 */
const envSchema = z.object({
  // Required: authentication
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a valid URL"),
  NEXTAUTH_SECRET: z.string().min(1, "NEXTAUTH_SECRET is required"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, "TOKEN_ENCRYPTION_KEY is required"),
  BADGE_SIGNING_KEY: z.string().optional(),

  // Required: GitHub org/team for maintainer access
  GITHUB_MAINTAINER_ORG: z.string().min(1, "GITHUB_MAINTAINER_ORG is required"),
  GITHUB_MAINTAINER_TEAM: z.string().optional(),

  // Required: database
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid URL")
    .refine((url) => {
      try {
        parseDatabasePoolConfig(url);
        return true;
      } catch {
        return false;
      }
    }, "DATABASE_URL contains invalid connection pool parameters"),

  // Optional: direct database URL for migrations bypassing PgBouncer
  DIRECT_URL: z.string().url("DIRECT_URL must be a valid URL").optional(),

  // Horizon/Stellar configuration — explicit, network-correct URLs only.
  // The previous silent mainnet default is gone: an unset or placeholder
  // Horizon URL must fail at boot with an actionable error.
  NEXT_PUBLIC_HORIZON_URL: httpUrlField("NEXT_PUBLIC_HORIZON_URL"),
  NEXT_PUBLIC_DEFAULT_ASSET_CODE: z.string().default("USDC"),
  NEXT_PUBLIC_DEFAULT_ASSET_ISSUER: z.string().default(
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ),
  NEXT_PUBLIC_MIN_XLM_BALANCE: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().nonnegative())
    .default("1.5"),
  NEXT_PUBLIC_BASE_RESERVE_XLM: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().positive())
    .optional()
    .default("0.5"),

  // Soroban & registry-mode configuration.
  // In contract-backed mode (REGISTRY_MODE=synced), SOROBAN_CONTRACT_ID,
  // SOROBAN_RPC_URL, and SOROBAN_OUTBOX_WORKER_URL are all required at boot.
  REGISTRY_MODE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? "" : v.trim().toLowerCase()))
    .refine(
      (v) =>
        v === "" ||
        (VALID_REGISTRY_MODES as readonly string[]).includes(v),
      `REGISTRY_MODE must be one of ${VALID_REGISTRY_MODES.join(", ")} [${ENV_VALIDATION_REASON_CODES.INVALID_REGISTRY_MODE}]`
    )
    .transform((v): RegistryMode => parseRegistryMode(v)),
  SOROBAN_CONTRACT_ID: z.string().optional(),
  SOROBAN_RPC_URL: httpUrlField("SOROBAN_RPC_URL").optional(),
  SOROBAN_OUTBOX_WORKER_URL: httpUrlField("SOROBAN_OUTBOX_WORKER_URL").optional(),
  SOROBAN_OUTBOX_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("15000"),

  // Registry mode selector. When set to "contract" the dashboard must have
  // both SOROBAN_CONTRACT_ID and SOROBAN_RPC_URL; otherwise it fails closed.
  NEXT_PUBLIC_REGISTRY_MODE: z.enum(["mock", "contract"]).optional(),

  // Webhook secret (optional at boot, but required for org membership sync — requests are rejected if missing)
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // trustbridge-action webhook secret (optional, but required for action sync verification)
  TRUSTBRIDGE_ACTION_SECRET: z.string().optional(),

  // Circuit breaker configuration
  HORIZON_CB_FAILURE_THRESHOLD: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("5"),
  HORIZON_CB_RECOVERY_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("30000"),
  HORIZON_CB_SUCCESS_THRESHOLD: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("2"),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("60000"),
  RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("10"),

  // CSV export staleness check
  STALE_CSV_MAX_AGE_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("86400000"), // 24 hours

  // Cron authentication & export configuration (optional)
  CRON_SECRET: z.string().optional(),
  TREASURY_EXPORT_EMAIL: z.string().email().optional(),
  CRON_EXPORT_EMAIL: z.string().email().optional(),
  CRON_EXPORT_MIN_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("60000"),
}).superRefine((env, ctx) => {
  const contractBacked = isContractBackedRegistryMode(env.REGISTRY_MODE);

  if (contractBacked) {
    if (!env.SOROBAN_OUTBOX_WORKER_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_OUTBOX_WORKER_URL"],
        message: `SOROBAN_OUTBOX_WORKER_URL is required when REGISTRY_MODE=synced (contract-backed registry mode); set it to your outbox worker http(s) URL or switch REGISTRY_MODE=live [${ENV_VALIDATION_REASON_CODES.OUTBOX_WORKER_URL_REQUIRED}]`,
      });
    }
    if (!env.SOROBAN_CONTRACT_ID?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_CONTRACT_ID"],
        message: `SOROBAN_CONTRACT_ID is required when REGISTRY_MODE=synced (contract-backed registry mode) [${ENV_VALIDATION_REASON_CODES.CONTRACT_ID_REQUIRED}]`,
      });
    }
    if (!env.SOROBAN_RPC_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_RPC_URL"],
        message: `SOROBAN_RPC_URL is required when REGISTRY_MODE=synced (contract-backed registry mode); point it at the same Stellar network as NEXT_PUBLIC_HORIZON_URL [${ENV_VALIDATION_REASON_CODES.SOROBAN_RPC_URL_REQUIRED}]`,
      });
    }
  } else if (env.SOROBAN_CONTRACT_ID && !env.SOROBAN_RPC_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SOROBAN_RPC_URL"],
      message: `SOROBAN_RPC_URL is required when SOROBAN_CONTRACT_ID is set; point it at the same Stellar network as NEXT_PUBLIC_HORIZON_URL [${ENV_VALIDATION_REASON_CODES.SOROBAN_RPC_URL_REQUIRED}]`,
    });
  }

  // Contract registry mode must be fully configured. Half-configured contract
  // mode corrupts Wave registration attempts, so fail closed at boot with a
  // stable reason code rather than silently falling back to mock mode.
  if (env.NEXT_PUBLIC_REGISTRY_MODE === "contract") {
    const hasContractId = Boolean(env.SOROBAN_CONTRACT_ID && env.SOROBAN_CONTRACT_ID.trim());
    const hasRpcUrl = Boolean(env.SOROBAN_RPC_URL && env.SOROBAN_RPC_URL.trim());

    if (!hasRpcUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_RPC_URL"],
        message:
          "[registry_mode_missing_rpc] NEXT_PUBLIC_REGISTRY_MODE=contract requires SOROBAN_RPC_URL; set it or switch to mock mode",
      });
    }

    if (!hasContractId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOROBAN_CONTRACT_ID"],
        message:
          "[registry_mode_missing_contract_id] NEXT_PUBLIC_REGISTRY_MODE=contract requires SOROBAN_CONTRACT_ID; set it or switch to mock mode",
      });
    }
  }

  const mixed = detectMixedNetworkConfig(env);
  if (mixed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SOROBAN_CONTRACT_ID"],
      message: `[${mixed.code}] ${mixed.message}`,
    });
  }
});

export type Environment = z.infer<typeof envSchema>;

/**
 * Validates environment variables at application boot.
 */
export function validateEnv(): Environment {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten();
    const fieldErrors = Object.entries(errors.fieldErrors)
      .map(([field, messages]) => `  ${field}: ${(messages ?? []).join(", ")}`)
      .join("\n");
    const formErrors = errors.formErrors.map((m) => `  ${m}`).join("\n");
    const details = [fieldErrors, formErrors].filter(Boolean).join("\n");
    throw new Error(`Environment validation failed:\n${details}`);
  }

  return result.data;
}
