import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  checkRateLimit,
  extractClientIp,
  resetRateLimit,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";
import { NextRequest } from "next/server";

describe("Rate Limiting", () => {
  beforeEach(() => {
    resetRateLimit();
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimit();
  });

  describe("checkRateLimit", () => {
    it("allows first request", () => {
      const result = checkRateLimit("user-1");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // 10 max - 1 used
      expect(result.retryAfter).toBe(0);
    });

    it("tracks remaining requests", () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit("user-1");
      }

      const result = checkRateLimit("user-1");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 10 - 6 total
    });

    it("blocks after max requests", () => {
      // Max is 10 by default
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user-1");
      }

      const result = checkRateLimit("user-1");

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("respects custom window and max", () => {
      const result1 = checkRateLimit("user-2", {
        windowMs: 60_000,
        maxRequests: 3,
      });
      expect(result1.allowed).toBe(true);

      checkRateLimit("user-2", {
        windowMs: 60_000,
        maxRequests: 3,
      });
      checkRateLimit("user-2", {
        windowMs: 60_000,
        maxRequests: 3,
      });

      const result4 = checkRateLimit("user-2", {
        windowMs: 60_000,
        maxRequests: 3,
      });

      expect(result4.allowed).toBe(false);
    });

    it("resets after window expires", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user-3", { windowMs: 5_000, maxRequests: 10 });
      }

      let result = checkRateLimit("user-3", {
        windowMs: 5_000,
        maxRequests: 10,
      });
      expect(result.allowed).toBe(false);

      // Advance past window
      vi.advanceTimersByTime(6_000);

      result = checkRateLimit("user-3", {
        windowMs: 5_000,
        maxRequests: 10,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it("calculates retryAfter correctly", () => {
      const opts = { windowMs: 10_000, maxRequests: 2 };

      // Fill up limit at time 0
      checkRateLimit("user-4", opts);
      checkRateLimit("user-4", opts);

      // Try at time 3_000
      vi.advanceTimersByTime(3_000);
      const result = checkRateLimit("user-4", opts);

      // First request expires at 10_000, so retry-after is 7 seconds
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(7);
    });

    it("tracks different identifiers separately", () => {
      const result1 = checkRateLimit("user-a");
      const result2 = checkRateLimit("user-b");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result1.remaining).toBe(9);
      expect(result2.remaining).toBe(9);
    });

    it("uses environment defaults", () => {
      process.env.RATE_LIMIT_WINDOW_MS = "30000";
      process.env.RATE_LIMIT_MAX_REQUESTS = "5";

      // Fill to max with env defaults
      for (let i = 0; i < 5; i++) {
        checkRateLimit("env-user");
      }

      const result = checkRateLimit("env-user");

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);

      delete process.env.RATE_LIMIT_WINDOW_MS;
      delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });

    it("handles invalid env vars gracefully", () => {
      process.env.RATE_LIMIT_MAX_REQUESTS = "invalid";

      const result = checkRateLimit("user-5");

      // Should use default (10)
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);

      delete process.env.RATE_LIMIT_MAX_REQUESTS;
    });
  });

  describe("extractClientIp", () => {
    it("extracts from x-forwarded-for header", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {
          "x-forwarded-for": "192.168.1.1, 10.0.0.1",
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("192.168.1.1");
    });

    it("uses x-real-ip if x-forwarded-for missing", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {
          "x-real-ip": "203.0.113.5",
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("203.0.113.5");
    });

    it("uses cf-connecting-ip if other headers missing", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {
          "cf-connecting-ip": "198.51.100.1",
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("198.51.100.1");
    });

    it("returns 'unknown' if no IP headers present", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {},
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("unknown");
    });

    it("prioritizes x-forwarded-for over other headers", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {
          "x-forwarded-for": "192.168.1.1",
          "x-real-ip": "203.0.113.5",
          "cf-connecting-ip": "198.51.100.1",
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("192.168.1.1");
    });

    it("trims whitespace from headers", () => {
      const request = new NextRequest("http://localhost:3000", {
        method: "GET",
        headers: {
          "x-real-ip": "  192.168.1.1  ",
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe("192.168.1.1");
    });
  });

  describe("buildRateLimitHeaders", () => {
    it("returns standard headers for allowed request", () => {
      const result = { allowed: true, retryAfter: 0, remaining: 7 };
      const headers = buildRateLimitHeaders(result, 10);

      expect(headers["RateLimit-Limit"]).toBe("10");
      expect(headers["RateLimit-Remaining"]).toBe("7");
      expect(headers["RateLimit-Reset"]).toBe("0");
      expect(headers["Retry-After"]).toBeUndefined();
    });

    it("returns Retry-After header when rate limited", () => {
      const result = { allowed: false, retryAfter: 15, remaining: 0 };
      const headers = buildRateLimitHeaders(result, 10);

      expect(headers["RateLimit-Limit"]).toBe("10");
      expect(headers["RateLimit-Remaining"]).toBe("0");
      expect(headers["RateLimit-Reset"]).toBe("15");
      expect(headers["Retry-After"]).toBe("15");
    });

    it("floors remaining at 0", () => {
      const result = { allowed: false, retryAfter: 5, remaining: -1 };
      const headers = buildRateLimitHeaders(result, 10);

      expect(headers["RateLimit-Remaining"]).toBe("0");
    });

    it("sets Reset to 0 for allowed requests", () => {
      const result = { allowed: true, retryAfter: 0, remaining: 9 };
      const headers = buildRateLimitHeaders(result, 10);

      expect(headers["RateLimit-Reset"]).toBe("0");
    });
  });

  describe("resetRateLimit", () => {
    it("resets specific identifier", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user-x");
      }

      let result = checkRateLimit("user-x");
      expect(result.allowed).toBe(false);

      resetRateLimit("user-x");

      result = checkRateLimit("user-x");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });

    it("resets all identifiers when no argument", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("user-a");
        checkRateLimit("user-b");
      }

      let resultA = checkRateLimit("user-a");
      let resultB = checkRateLimit("user-b");
      expect(resultA.allowed).toBe(false);
      expect(resultB.allowed).toBe(false);

      resetRateLimit();

      resultA = checkRateLimit("user-a");
      resultB = checkRateLimit("user-b");
      expect(resultA.allowed).toBe(true);
      expect(resultB.allowed).toBe(true);
    });
  });
});
