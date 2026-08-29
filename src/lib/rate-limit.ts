import { NextRequest } from "next/server";

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

function getDefaultOptions(): RateLimitOptions {
  const windowMs = Number.parseInt(
    process.env.RATE_LIMIT_WINDOW_MS ?? "60000",
    10
  );
  const maxRequests = Number.parseInt(
    process.env.RATE_LIMIT_MAX_REQUESTS ?? "10",
    10
  );
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 10,
  };
}

/**
 * Check if a request from the given identifier is within the rate limit.
 * Uses an in-memory sliding window.
 */
export function checkRateLimit(
  identifier: string,
  options?: Partial<RateLimitOptions>
): { allowed: boolean; retryAfter: number; remaining: number } {
  const opts = { ...getDefaultOptions(), ...options };
  const now = Date.now();
  const entry = store.get(identifier);

  if (!entry) {
    store.set(identifier, { timestamps: [now] });
    return { allowed: true, retryAfter: 0, remaining: opts.maxRequests - 1 };
  }

  const validTimestamps = entry.timestamps.filter(
    (t) => now - t < opts.windowMs
  );

  if (validTimestamps.length >= opts.maxRequests) {
    const oldest = validTimestamps[0];
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest + opts.windowMs - now) / 1000)
    );
    store.set(identifier, { timestamps: validTimestamps });
    return { allowed: false, retryAfter, remaining: 0 };
  }

  validTimestamps.push(now);
  store.set(identifier, { timestamps: validTimestamps });
  return {
    allowed: true,
    retryAfter: 0,
    remaining: opts.maxRequests - validTimestamps.length,
  };
}

/**
 * Extract client IP from common proxy headers.
 */
export function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "unknown";
}

/**
 * Build standard RateLimit-* response headers (draft-ietf-httpapi-ratelimit-headers-07).
 *
 * - `RateLimit-Limit` — max requests per window
 * - `RateLimit-Remaining` — requests left in current window
 * - `RateLimit-Reset` — seconds until the window resets
 * - `Retry-After` — seconds to wait (only set when `retryAfter > 0`)
 *
 * Multi-instance note: in-memory counters are per-process. When running
 * behind a load balancer with N instances, the effective limit is roughly
 * N × maxRequests. This is documented in ENVIRONMENT.md.
 */
export function buildRateLimitHeaders(
  result: { allowed: boolean; retryAfter: number; remaining: number },
  maxRequests: number
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(maxRequests),
    "RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "RateLimit-Reset": String(Math.max(0, result.retryAfter)),
  };

  if (!result.allowed && result.retryAfter > 0) {
    headers["Retry-After"] = String(result.retryAfter);
  }

  return headers;
}

/**
 * Reset rate limit state for a given identifier or all identifiers.
 * Primarily for testing.
 */
export function resetRateLimit(identifier?: string): void {
  if (identifier) {
    store.delete(identifier);
  } else {
    store.clear();
  }
}
