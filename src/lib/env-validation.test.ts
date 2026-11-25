import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ENV_VALIDATION_REASON_CODES,
  validateEnv,
} from "@/lib/env-validation";

const BASE_VALID_ENV: Record<string, string> = {
  GITHUB_CLIENT_ID: "test-id",
  GITHUB_CLIENT_SECRET: "test-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "test-secret-123",
  TOKEN_ENCRYPTION_KEY: "test-key-123",
  GITHUB_MAINTAINER_ORG: "test-org",
  DATABASE_URL: "postgresql://localhost/test",
  NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
};

describe("env-validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Save original env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe("validateEnv - required fields", () => {
    it("validates a complete valid configuration", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "test-secret-123",
        TOKEN_ENCRYPTION_KEY: "test-key-123",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "postgresql://localhost/test",
        NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
        NEXT_PUBLIC_DEFAULT_ASSET_CODE: "USDC",
        NEXT_PUBLIC_DEFAULT_ASSET_ISSUER:
          "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      };

      const env = validateEnv();
      expect(env.GITHUB_CLIENT_ID).toBe("test-id");
      expect(env.GITHUB_MAINTAINER_ORG).toBe("test-org");
      expect(env.DATABASE_URL).toBe("postgresql://localhost/test");
    });

    it("fails when GITHUB_CLIENT_ID is missing", () => {
      process.env = {
        GITHUB_CLIENT_SECRET: "secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "secret",
        TOKEN_ENCRYPTION_KEY: "key",
        GITHUB_MAINTAINER_ORG: "org",
        DATABASE_URL: "postgresql://localhost/test",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });

    it("fails when DATABASE_URL is invalid", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY: "test-key",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "not-a-url",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });
  });

  describe("validateEnv - numeric parsing", () => {
    it("parses numeric env vars as numbers", () => {
      process.env = {
        ...BASE_VALID_ENV,
        RATE_LIMIT_MAX_REQUESTS: "20",
        RATE_LIMIT_WINDOW_MS: "120000",
        NEXT_PUBLIC_MIN_XLM_BALANCE: "2.5",
        HORIZON_CB_FAILURE_THRESHOLD: "10",
      };

      const env = validateEnv();
      expect(env.RATE_LIMIT_MAX_REQUESTS).toBe(20);
      expect(typeof env.RATE_LIMIT_MAX_REQUESTS).toBe("number");
      expect(env.RATE_LIMIT_WINDOW_MS).toBe(120000);
      expect(env.NEXT_PUBLIC_MIN_XLM_BALANCE).toBe(2.5);
      expect(env.HORIZON_CB_FAILURE_THRESHOLD).toBe(10);
    });

    it("fails when numeric env var is invalid", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY: "test-key",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "postgresql://localhost/test",
        RATE_LIMIT_MAX_REQUESTS: "not-a-number",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });

    it("fails when numeric value is negative", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY: "test-key",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "postgresql://localhost/test",
        NEXT_PUBLIC_MIN_XLM_BALANCE: "-1",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });
  });

  describe("validateEnv - optional fields and defaults", () => {
    it("uses default values for optional fields", () => {
      process.env = {
        ...BASE_VALID_ENV,
      };

      const env = validateEnv();
      expect(env.NEXT_PUBLIC_HORIZON_URL).toBe("https://horizon.stellar.org");
      expect(env.NEXT_PUBLIC_DEFAULT_ASSET_CODE).toBe("USDC");
      expect(env.RATE_LIMIT_MAX_REQUESTS).toBe(10);
      expect(env.HORIZON_CB_FAILURE_THRESHOLD).toBe(5);
      expect(env.REGISTRY_MODE).toBe("live");
      expect(env.SOROBAN_OUTBOX_INTERVAL_MS).toBe(15000);
    });

    it("allows optional fields to be omitted", () => {
      process.env = {
        ...BASE_VALID_ENV,
      };

      const env = validateEnv();
      expect(env.SOROBAN_CONTRACT_ID).toBeUndefined();
      expect(env.SOROBAN_OUTBOX_WORKER_URL).toBeUndefined();
      expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
      expect(env.GITHUB_MAINTAINER_TEAM).toBeUndefined();
    });
  });

  describe("validateEnv - URL validation", () => {
    it("validates NEXTAUTH_URL as a valid URL", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "not-a-url",
        NEXTAUTH_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY: "test-key",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "postgresql://localhost/test",
      };

      expect(() => validateEnv()).toThrow("NEXTAUTH_URL must be a valid URL");
    });

    it("accepts https URLs", () => {
      process.env = {
        ...BASE_VALID_ENV,
        NEXTAUTH_URL: "https://example.com",
      };

      const env = validateEnv();
      expect(env.NEXTAUTH_URL).toBe("https://example.com");
    });
  });

  describe("error reporting", () => {
    it("includes helpful error messages for missing required fields", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        // Missing everything else
      };

      try {
        validateEnv();
        expect.fail("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Environment validation failed");
        expect(message).toContain("GITHUB_CLIENT_SECRET");
        expect(message).toContain("NEXTAUTH_URL");
      }
    });
  });

  describe("validateEnv - mixed network contract ids", () => {
    const baseEnv = {
      GITHUB_CLIENT_ID: "test-id",
      GITHUB_CLIENT_SECRET: "test-secret",
      NEXTAUTH_URL: "http://localhost:3000",
      NEXTAUTH_SECRET: "test-secret",
      TOKEN_ENCRYPTION_KEY: "test-key",
      GITHUB_MAINTAINER_ORG: "test-org",
      DATABASE_URL: "postgresql://localhost/test",
    };

    it("accepts a testnet contract id with a testnet horizon url", () => {
      process.env = {
        ...baseEnv,
        NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_CONTRACT_ID:
          "CDTESTNETCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      };

      const env = validateEnv();
      expect(env.SOROBAN_CONTRACT_ID).toBe(
        "CDTESTNETCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      );
    });

    it("warns when a testnet contract id is paired with a pubnet horizon url", () => {
      process.env = {
        ...baseEnv,
        NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
        SOROBAN_CONTRACT_ID:
          "CDTESTNETCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const env = validateEnv();
        expect(env.SOROBAN_CONTRACT_ID).toBe(
          "CDTESTNETCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        );
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls
          .map((call) => call.join(" "))
          .join("\n");
        expect(warned).toContain("ENV_NETWORK_MISMATCH");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("warns when a pubnet contract id is paired with a testnet horizon url", () => {
      process.env = {
        ...baseEnv,
        NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_CONTRACT_ID:
          "CDPUBTESTNETCONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      };

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        validateEnv();
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls
          .map((call) => call.join(" "))
          .join("\n");
        expect(warned).toContain("ENV_NETWORK_MISMATCH");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("fails when SOROBAN_CONTRACT_ID is malformed", () => {
      process.env = {
        ...baseEnv,
        NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
        SOROBAN_CONTRACT_ID: "not-a-contract-id",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });

    it("fails when SOROBAN_CONTRACT_ID is empty", () => {
      process.env = {
        ...baseEnv,
        NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
        SOROBAN_CONTRACT_ID: "",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });
  });

  describe("validateEnv - DATABASE_URL pool and pgbouncer settings", () => {
    it("accepts DATABASE_URL with connection_limit and pool_timeout", () => {
      process.env = {
        ...BASE_VALID_ENV,
        DATABASE_URL: "postgresql://localhost/test?connection_limit=5&pool_timeout=10&pgbouncer=true&idle_in_transaction_session_timeout=30000",
      };

      const env = validateEnv();
      expect(env.DATABASE_URL).toContain("connection_limit=5");
      expect(env.DATABASE_URL).toContain("pgbouncer=true");
    });

    it("fails when connection_limit is invalid", () => {
      process.env = {
        GITHUB_CLIENT_ID: "test-id",
        GITHUB_CLIENT_SECRET: "test-secret",
        NEXTAUTH_URL: "http://localhost:3000",
        NEXTAUTH_SECRET: "test-secret",
        TOKEN_ENCRYPTION_KEY: "test-key",
        GITHUB_MAINTAINER_ORG: "test-org",
        DATABASE_URL: "postgresql://localhost/test?connection_limit=not-a-number",
      };

      expect(() => validateEnv()).toThrow("Environment validation failed");
    });
  });

  describe("validateEnv - contract-backed registry mode & outbox worker URL (Issue #796)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("passes when REGISTRY_MODE=synced includes valid outbox worker URL, contract ID, and Soroban RPC URL", () => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "  SYNCED  ",
        SOROBAN_CONTRACT_ID: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        SOROBAN_OUTBOX_WORKER_URL: "https://worker.trustbridge.internal/outbox",
        SOROBAN_OUTBOX_INTERVAL_MS: "10000",
      };

      const env = validateEnv();
      expect(env.REGISTRY_MODE).toBe("synced");
      expect(env.SOROBAN_OUTBOX_WORKER_URL).toBe(
        "https://worker.trustbridge.internal/outbox",
      );
      expect(env.SOROBAN_OUTBOX_INTERVAL_MS).toBe(10000);
    });

    it("does not require SOROBAN_OUTBOX_WORKER_URL when REGISTRY_MODE is live or unset", () => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "live",
      };

      const env = validateEnv();
      expect(env.REGISTRY_MODE).toBe("live");
      expect(env.SOROBAN_OUTBOX_WORKER_URL).toBeUndefined();
    });

    it("fails fast with OUTBOX_WORKER_URL_REQUIRED when REGISTRY_MODE=synced omits SOROBAN_OUTBOX_WORKER_URL", () => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "synced",
        SOROBAN_CONTRACT_ID: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      };

      try {
        validateEnv();
        expect.fail("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("SOROBAN_OUTBOX_WORKER_URL");
        expect(message).toContain(ENV_VALIDATION_REASON_CODES.OUTBOX_WORKER_URL_REQUIRED);
        // Never leak secret env values in validation errors.
        expect(message).not.toContain(BASE_VALID_ENV.GITHUB_CLIENT_SECRET);
        expect(message).not.toContain(BASE_VALID_ENV.TOKEN_ENCRYPTION_KEY);
      }
    });

    it("fails fast with CONTRACT_ID_REQUIRED and SOROBAN_RPC_URL_REQUIRED when REGISTRY_MODE=synced omits Soroban config", () => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "synced",
      };

      try {
        validateEnv();
        expect.fail("Should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(ENV_VALIDATION_REASON_CODES.OUTBOX_WORKER_URL_REQUIRED);
        expect(message).toContain(ENV_VALIDATION_REASON_CODES.CONTRACT_ID_REQUIRED);
        expect(message).toContain(ENV_VALIDATION_REASON_CODES.SOROBAN_RPC_URL_REQUIRED);
      }
    });

    it.each([
      "not-a-url",
      "ftp://worker.trustbridge.internal/outbox",
      "https://example.com/worker",
      "https://your-worker.local/outbox",
      `https://worker.trustbridge.internal/${"a".repeat(2050)}`,
    ])("rejects malformed, placeholder, non-http, or oversized SOROBAN_OUTBOX_WORKER_URL (%s)", (badUrl) => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "synced",
        SOROBAN_CONTRACT_ID: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        SOROBAN_OUTBOX_WORKER_URL: badUrl,
      };

      expect(() => validateEnv()).toThrow("SOROBAN_OUTBOX_WORKER_URL");
    });

    it("rejects an unrecognized REGISTRY_MODE with INVALID_REGISTRY_MODE", () => {
      process.env = {
        ...BASE_VALID_ENV,
        REGISTRY_MODE: "contract-typo",
      };

      expect(() => validateEnv()).toThrow(
        ENV_VALIDATION_REASON_CODES.INVALID_REGISTRY_MODE,
      );
    });
  });
});
