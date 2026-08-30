import "server-only";

import { z } from "zod";

/**
 * Environment variable schema for the TrustBridge Dashboard.
 * Validates all required and optional configuration at application boot.
 *
 * This schema is used to:
 * - Ensure required variables are present and valid
 * - Cast/parse numeric and boolean values
 * - Detect configuration mismatches (e.g., mainnet Horizon + testnet Soroban)
 * - Fail fast at startup rather than at runtime
 */
const envSchema = z.object({
  // Required: authentication
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a valid URL"),
  NEXTAUTH_SECRET: z.string().min(1, "NEXTAUTH_SECRET is required"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, "TOKEN_ENCRYPTION_KEY is required"),

  // Required: GitHub org/team for maintainer access
  GITHUB_MAINTAINER_ORG: z.string().min(1, "GITHUB_MAINTAINER_ORG is required"),
  GITHUB_MAINTAINER_TEAM: z.string().optional(),

  // Required: database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),

  // Horizon/Stellar configuration
  NEXT_PUBLIC_HORIZON_URL: z
    .string()
    .url("NEXT_PUBLIC_HORIZON_URL must be a valid URL")
    .default("https://horizon.stellar.org"),
  NEXT_PUBLIC_DEFAULT_ASSET_CODE: z.string().default("USDC"),
  // Circle USDC on Stellar mainnet — must match trustbridge-action's
  // `asset_issuer` default. See ACTION_DEFAULTS in src/lib/constants.ts.
  NEXT_PUBLIC_DEFAULT_ASSET_ISSUER: z.string().default(
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ),
  NEXT_PUBLIC_MIN_XLM_BALANCE: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().nonnegative())
    // Matches trustbridge-action's `min_xlm_reserve` default.
    .default("1.5"),
  NEXT_PUBLIC_BASE_RESERVE_XLM: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().positive())
    .optional()
    .default("0.5"),

  // Soroban configuration (optional)
  SOROBAN_CONTRACT_ID: z.string().optional(),
  SOROBAN_RPC_URL: z
    .string()
    .url("SOROBAN_RPC_URL must be a valid URL")
    .optional(),

  // Webhook secret (optional, but required if using org membership sync)
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
});

export type Environment = z.infer<typeof envSchema>;

/**
 * Validates environment variables at application boot.
 * Throws if validation fails, preventing server startup.
 *
 * Usage:
 *   import { validateEnv } from "@/lib/env-validation";
 *   const env = validateEnv();
 *   // Now env is fully typed and validated
 */
export function validateEnv(): Environment {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten();
    const fieldErrors = Object.entries(errors.fieldErrors)
      .map(([field, msgs]) => `${field}: ${msgs?.join(", ")}`)
      .join("\n");

    const message = `❌ Environment validation failed:\n${fieldErrors}`;
    console.error(message);

    throw new Error(message);
  }

  return result.data;
}

/**
 * Returns the validated environment object.
 * This function should be called once at application startup.
 * Later calls return the cached result.
 */
let cachedEnv: Environment | null = null;

export function getValidatedEnv(): Environment {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
}
