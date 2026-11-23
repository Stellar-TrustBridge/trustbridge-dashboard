import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildActionLookupResult,
  computeNextAction,
  lookupActionRepo,
  NEGATIVE_CACHE_TTL_MS,
  resetActionLookupNegativeCache,
} from "@/lib/action-lookup";
import type { HorizonCheckResult } from "@/types";

function result(overrides: Partial<HorizonCheckResult>): HorizonCheckResult {
  return {
    funded: false,
    trustline: false,
    trustline_authorized: false,
    verified: false,
    xlm_balance: "0",
    spendable_xlm_balance: "0",
    errors: [],
    readiness: "not_ready",
    ...overrides,
  };
}

describe("computeNextAction", () => {
  it("tells an unfunded account to fund itself (success path)", () => {
    expect(
      computeNextAction({
        funded: false,
        trustline: false,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("fund_account");
  });

  it("tells a funded account without a trustline to add one", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: false,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("add_trustline");
  });

  it("tells a funded account with an unauthorized trustline to wait on the issuer", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("await_trustline_authorization");
  });

  it("tells a low-reserve account to top up XLM", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        readiness: "low_reserve",
      })
    ).toBe("increase_reserve");
  });

  it("reports no action needed once ready", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        readiness: "ready",
      })
    ).toBe("none");
  });
});

describe("buildActionLookupResult", () => {
  it("preserves the underlying Horizon errors on a failure path", () => {
    const horizonResult = result({
      errors: ["Horizon error: rate limited"],
    });

    const lookup = buildActionLookupResult(horizonResult);

    expect(lookup.errors).toEqual(["Horizon error: rate limited"]);
    expect(lookup.nextAction).toBe("fund_account");
  });

  it("merges the computed next action alongside the readiness fields", () => {
    const horizonResult = result({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      xlm_balance: "5",
      readiness: "ready",
    });

    expect(buildActionLookupResult(horizonResult)).toEqual({
      ...horizonResult,
      nextAction: "none",
    });
  });
});

describe("lookupActionRepo negative caching", () => {
  beforeEach(() => {
    resetActionLookupNegativeCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetActionLookupNegativeCache();
  });

  it("caches a 404 so repeated lookups skip the fetcher (happy path)", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 404 });

    const first = await lookupActionRepo("acme/missing", { fetcher });
    const second = await lookupActionRepo("acme/missing", { fetcher });

    expect(first).toEqual({ found: false, cached: false });
    expect(second).toEqual({ found: false, cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache non-404 failures and surfaces the error", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 500 });

    const first = await lookupActionRepo("acme/broken", { fetcher });
    const second = await lookupActionRepo("acme/broken", { fetcher });

    expect(first.found).toBe(false);
    expect(first.error).toMatch(/500/);
    expect(second.found).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires the negative entry after the short TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 404 });

    await lookupActionRepo("acme/missing", { fetcher });
    vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS + 1);
    await lookupActionRepo("acme/missing", { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache successful lookups as negative entries", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, data: { id: 1 } });

    const first = await lookupActionRepo("acme/present", { fetcher });
    const second = await lookupActionRepo("acme/present", { fetcher });

    expect(first.found).toBe(true);
    expect(second.found).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
