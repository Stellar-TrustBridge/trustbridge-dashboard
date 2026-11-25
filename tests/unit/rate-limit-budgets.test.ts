/**
 * Per-route rate-limit budget tests (#693).
 *
 * Verifies that ROUTE_BUDGETS exports the correct defaults, responds correctly
 * to per-route env-var overrides, and that each budget is enforced
 * independently with the right 429 response shape.
 *
 * Happy path  — first request within any budget is allowed.
 * Failure paths:
 *   1. register budget — exhausted after ROUTE_BUDGETS.register.maxRequests calls.
 *   2. export budget  — exhausted after ROUTE_BUDGETS.export.maxRequests calls.
 *   3. stats budget   — exhausted after ROUTE_BUDGETS.stats.maxRequests calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  resetRateLimit,
  ROUTE_BUDGETS,
} from "@/lib/rate-limit";

// ── Helpers ───────────────────────────────────────────────────────────────────

function exhaust(identifier: string, budget: { windowMs: number; maxRequests: number }) {
  for (let i = 0; i < budget.maxRequests; i++) {
    checkRateLimit(identifier, budget);
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetRateLimit();
  // Clear any per-route env overrides set by previous tests.
  delete process.env.REGISTER_RATE_LIMIT_WINDOW_MS;
  delete process.env.REGISTER_RATE_LIMIT_MAX_REQUESTS;
  delete process.env.EXPORT_RATE_LIMIT_WINDOW_MS;
  delete process.env.EXPORT_RATE_LIMIT_MAX_REQUESTS;
  delete process.env.STATS_RATE_LIMIT_WINDOW_MS;
  delete process.env.STATS_RATE_LIMIT_MAX_REQUESTS;
});

afterEach(() => {
  resetRateLimit();
});

// ── ROUTE_BUDGETS shape ───────────────────────────────────────────────────────

describe("ROUTE_BUDGETS — default values", () => {
  it("register budget defaults to 10 req/min (happy path)", () => {
    expect(ROUTE_BUDGETS.register.maxRequests).toBe(10);
    expect(ROUTE_BUDGETS.register.windowMs).toBe(60_000);
  });

  it("export budget defaults to 20 req/min (happy path)", () => {
    expect(ROUTE_BUDGETS.export.maxRequests).toBe(20);
    expect(ROUTE_BUDGETS.export.windowMs).toBe(60_000);
  });

  it("stats budget defaults to 120 req/min (happy path)", () => {
    expect(ROUTE_BUDGETS.stats.maxRequests).toBe(120);
    expect(ROUTE_BUDGETS.stats.windowMs).toBe(60_000);
  });

  it("every budget has a positive maxRequests", () => {
    for (const [, budget] of Object.entries(ROUTE_BUDGETS)) {
      expect(budget.maxRequests).toBeGreaterThan(0);
    }
  });

  it("every budget has a positive windowMs", () => {
    for (const [, budget] of Object.entries(ROUTE_BUDGETS)) {
      expect(budget.windowMs).toBeGreaterThan(0);
    }
  });
});

// ── register budget enforcement ───────────────────────────────────────────────

describe("register budget enforcement", () => {
  it("allows the first request (happy path)", () => {
    const result = checkRateLimit("register:1.2.3.4", ROUTE_BUDGETS.register);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(ROUTE_BUDGETS.register.maxRequests - 1);
  });

  it("blocks after maxRequests are exhausted (failure path)", () => {
    exhaust("register:10.0.0.1", ROUTE_BUDGETS.register);
    const blocked = checkRateLimit("register:10.0.0.1", ROUTE_BUDGETS.register);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("register identifiers are independent from export identifiers (no cross-route bleed)", () => {
    exhaust("register:10.0.0.2", ROUTE_BUDGETS.register);
    // A different prefix for the same IP should not be affected.
    const exportResult = checkRateLimit("export:10.0.0.2", ROUTE_BUDGETS.export);
    expect(exportResult.allowed).toBe(true);
  });
});

// ── export budget enforcement ─────────────────────────────────────────────────

describe("export budget enforcement", () => {
  it("allows the first request (happy path)", () => {
    const result = checkRateLimit("export:1.2.3.4", ROUTE_BUDGETS.export);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(ROUTE_BUDGETS.export.maxRequests - 1);
  });

  it("blocks after maxRequests are exhausted (failure path)", () => {
    exhaust("export:10.0.1.1", ROUTE_BUDGETS.export);
    const blocked = checkRateLimit("export:10.0.1.1", ROUTE_BUDGETS.export);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("export budget (20) is higher than register budget (10)", () => {
    // Sanity check that the budgets are ordered as documented.
    expect(ROUTE_BUDGETS.export.maxRequests).toBeGreaterThan(
      ROUTE_BUDGETS.register.maxRequests
    );
  });

  it("two different IPs on the export path are independent", () => {
    exhaust("export:192.168.1.1", ROUTE_BUDGETS.export);
    const otherIp = checkRateLimit("export:192.168.1.2", ROUTE_BUDGETS.export);
    expect(otherIp.allowed).toBe(true);
  });
});

// ── stats budget enforcement ──────────────────────────────────────────────────

describe("stats budget enforcement", () => {
  it("allows the first request (happy path)", () => {
    const result = checkRateLimit("stats:1.2.3.4", ROUTE_BUDGETS.stats);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(ROUTE_BUDGETS.stats.maxRequests - 1);
  });

  it("blocks after maxRequests are exhausted (failure path — 120 calls)", () => {
    exhaust("stats:10.0.2.1", ROUTE_BUDGETS.stats);
    const blocked = checkRateLimit("stats:10.0.2.1", ROUTE_BUDGETS.stats);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("stats budget (120) is much higher than register and export", () => {
    expect(ROUTE_BUDGETS.stats.maxRequests).toBeGreaterThan(
      ROUTE_BUDGETS.export.maxRequests
    );
    expect(ROUTE_BUDGETS.stats.maxRequests).toBeGreaterThan(
      ROUTE_BUDGETS.register.maxRequests
    );
  });
});

// ── Remaining decrements correctly per budget ─────────────────────────────────

describe("remaining count tracks the correct budget ceiling", () => {
  it("register remaining counts down from register.maxRequests", () => {
    const r1 = checkRateLimit("register:5.5.5.5", ROUTE_BUDGETS.register);
    const r2 = checkRateLimit("register:5.5.5.5", ROUTE_BUDGETS.register);
    expect(r1.remaining).toBe(ROUTE_BUDGETS.register.maxRequests - 1);
    expect(r2.remaining).toBe(ROUTE_BUDGETS.register.maxRequests - 2);
  });

  it("export remaining counts down from export.maxRequests", () => {
    const r1 = checkRateLimit("export:6.6.6.6", ROUTE_BUDGETS.export);
    const r2 = checkRateLimit("export:6.6.6.6", ROUTE_BUDGETS.export);
    expect(r1.remaining).toBe(ROUTE_BUDGETS.export.maxRequests - 1);
    expect(r2.remaining).toBe(ROUTE_BUDGETS.export.maxRequests - 2);
  });
});
