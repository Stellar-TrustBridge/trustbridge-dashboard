import "server-only";

import { z } from "zod";

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
    /<[^>]*>|\.\.\.|change[-_ ]?me|placeholder|replace[-_ ]?me|your[-_ ]?(url|horizon|rpc)|example\.(com|org|net)|^(todo|tbd|none|null|undefined|x+)$/.test(
      normalized
    )
  );
}

/**
 * Required-or-explicitly-optional HTTP(S) URL field. Rejects non-http schemes
 * and placeholder values that would otherwise pass Zod's generic `.url()`.
 */
function httpUrlField(name: string) {
  return z
    .string()
    .min(1, `${name} is required`)
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
 * Hostnames that must never be reachable from operator-supplied base URLs.
 * Mirrors the SSRF posture used by other outbound clients (loopback,
 * link-local, cloud metadata, and internal-only suffixes).
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

/**
 * Returns true when the hostname is a private/loopback/link-local/metadata
 * address or an internal-only hostname that would turn the dashboard into an
 * SSRF proxy.
 */
function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // IPv4 literal checks (loopback, private, link-local, metadata, CGNAT).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // IPv6 literal checks (loopback, unspecified, unique-local, link-local).
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10
    return false;
  }

  return false;
}

/**
 * Validates an operator-supplied Action/check base URL with the same SSRF
 * posture as other outbound clients: http(s) only, no embedded credentials,
 * no private/loopback/link-local/metadata hosts, and no disallowed ports.
 */
export function validateActionBaseUrl(value: string): string {
  if (isPlaceholderUrl(value)) {
    throw new Error("Action base URL must be a real http(s) URL (placeholders are not allowed)");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Action base URL must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Action base URL must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Action base URL must not contain embedded credentials");
  }

  if (parsed.port) {
    const port = Number(parsed.port);
    const allowed = parsed.protocol === "https:" ? [443] : [80];
    if (!allowed.includes(port)) {
      throw new Error("Action base URL must not use a non-standard port");
    }
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("Action base URL must not target a private, loopback, or metadata host");
  }

  return value;
}

/**
 * Optional Action/check base URL field. When set, it is validated with the
 * SSRF posture above so a misconfigured base cannot proxy internal traffic.
 */
function actionBaseUrlField(name: string) {
  return z
    .string()
    .min(1, `${name} must not be empty`)
    .superRefine((value, ctx) => {
      try {
        validateActionBaseUrl(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : `${name} is invalid`,
        });
      }
    });
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

  // Soroban configuration. The RPC URL is optional only when there is no
  // contract ID; the cross-field check below enforces that pairing.
  SOROBAN_CONTRACT_ID: z.string().optional(),
  SOROBAN_RPC_URL: httpUrlField("SOROBAN_RPC_URL").optional(),

  // Configurable Action/check base URL. Validated with the same SSRF posture
  // as other outbound clients so a misconfigured base cannot proxy internal
  // traffic (loopback, private, link-local, metadata, credentials, ports).
  TRUSTBRIDGE_ACTION_BASE_URL: actionBaseUrlField("TRUSTBRIDGE_ACTION_BASE_URL").optional(),

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
  if (env.SOROBAN_CONTRACT_ID && !env.SOROBAN_RPC_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SOROBAN_RPC_URL"],
      message:
        "SOROBAN_RPC_URL is required when SOROBAN_CONTRACT_ID is set; point it at the same Stellar network as NEXT_PUBLIC_HORIZON_URL",
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
      .map(([field, messages]) => `${field}: ${messages?.join(", ")}`)
      .join("; ");
    throw new Error(`Environment validation failed: ${fieldErrors}`);
  }

  return result.data;
}
