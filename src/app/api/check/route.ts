import { NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "@/lib/csrf";
import {
  extractClientIp,
  checkRateLimit,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";
import { jsonCheckError, jsonCheckResult } from "@/lib/check-api";
import { DEFAULT_ASSET } from "@/lib/constants";
import { checkStellarAddress } from "@/lib/horizon";
import { checkCache, buildCacheKey } from "@/lib/cache";
import { captureException } from "@/lib/sentry";
import type { CheckAddressPayload, HorizonCheckResult } from "@/types";

export const runtime = "nodejs";

/**
 * Build the cache key used by the /api/check route layer.
 * Distinct prefix ("check") from the internal horizon cache ("horizon") so
 * the two layers can be invalidated independently.
 */
function buildCheckCacheKey(
  address: string,
  assetCode: string,
  assetIssuer: string
): string {
  return buildCacheKey("check", address, assetCode, assetIssuer);
}

/**
 * Whether the request has explicitly requested a cache bypass.
 * Accepted signals:
 *  - `X-Cache-Bypass: 1` header  (maintainer tooling / batch re-check flows)
 *  - `cache_bypass=1` query param (convenience for direct API consumers)
 */
function isCacheBypass(request: NextRequest): boolean {
  if (request.headers.get("x-cache-bypass") === "1") return true;
  if (request.nextUrl.searchParams.get("cache_bypass") === "1") return true;
  return false;
}

export async function POST(request: NextRequest) {
  // ── CSRF guard ─────────────────────────────────────────────────────────────
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  // ── Rate limit ─────────────────────────────────────────────────────────────
  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp);
  const rateLimitHeaders = buildRateLimitHeaders(rateLimit, 10);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { errors: ["Rate limit exceeded. Please try again later."] },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  try {
    const body = (await request.json()) as CheckAddressPayload;
    const address = body.address?.trim();

    if (!address) {
      return jsonCheckError(["Address is required"], 400);
    }

    const assetCode = body.asset_code ?? DEFAULT_ASSET.code;
    const assetIssuer = body.asset_issuer ?? DEFAULT_ASSET.issuer;
    const bypass = isCacheBypass(request);
    const cacheKey = buildCheckCacheKey(address, assetCode, assetIssuer);

    // ── KV cache read ────────────────────────────────────────────────────────
    if (!bypass) {
      const cached = checkCache.get(cacheKey) as HorizonCheckResult | null;
      if (cached) {
        const res = jsonCheckResult(cached);
        for (const [k, v] of Object.entries(rateLimitHeaders)) {
          res.headers.set(k, v);
        }
        return res;
      }
    }

    // ── Horizon call ─────────────────────────────────────────────────────────
    // Pass useCache: false when the caller explicitly bypassed the route cache
    // so that even the internal horizon.ts verificationCache is skipped and a
    // truly fresh Horizon response is returned.
    const result = await checkStellarAddress(address, assetCode, assetIssuer, {
      useCache: !bypass,
    });

    // ── KV cache write (success-only) ────────────────────────────────────────
    // Transient / circuit-breaker errors are never cached so a follow-up
    // request can succeed once Horizon recovers.
    const isTransient =
      result.errors?.some(
        (e) =>
          e.includes("temporarily unavailable") ||
          e.startsWith("Horizon error:")
      ) ?? false;

    if (!bypass && !isTransient) {
      checkCache.set(cacheKey, result);
    }

    const res = jsonCheckResult(result);
    for (const [k, v] of Object.entries(rateLimitHeaders)) {
      res.headers.set(k, v);
    }
    return res;
  } catch (error) {
    // NOTE: the address is intentionally *not* passed as context. It is the
    // one field a caller controls and it is a G-address — `captureException`
    // would redact it anyway, so sending it buys nothing.
    captureException(error, { route: "/api/check", method: "POST" });
    return jsonCheckError(["Failed to check address"], 500);
  }
}
