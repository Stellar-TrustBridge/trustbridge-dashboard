import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function getAllowedHosts(request: NextRequest): Set<string> {
  const hosts = new Set<string>();

  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) {
    forwarded.split(",").forEach((h) => hosts.add(h.trim().toLowerCase()));
  }

  const host = request.headers.get("host");
  if (host) {
    hosts.add(host.trim().toLowerCase());
  }

  // Fallback to URL host (e.g., in test environments where Host header is absent)
  const urlHost = request.nextUrl.host;
  if (urlHost) {
    hosts.add(urlHost.trim().toLowerCase());
  }

  const nextauthUrl = process.env.NEXTAUTH_URL;
  if (nextauthUrl) {
    try {
      const { host: nh } = new URL(nextauthUrl);
      if (nh) hosts.add(nh.trim().toLowerCase());
    } catch {
      // Malformed NEXTAUTH_URL: ignore gracefully (invalid env config edge case)
    }
  }

  return hosts;
}

function parseHostFromOrigin(origin: string): string | null {
  try {
    const { host } = new URL(origin);
    return host ? host.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Validates that a mutating request originates from the same origin
 * as the application. Safe methods (GET, HEAD, OPTIONS) bypass.
 *
 * Policy:
 * - If Origin header is present → must match allowed host(s)
 * - If Origin absent → check Referer → must match allowed host(s)
 * - If both absent → allow (non-browser/API client; no cookie-based CSRF risk)
 *
 * Returns a 403 NextResponse when rejected, or null when allowed.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) {
    return null;
  }

  const allowedHosts = getAllowedHosts(request);

  const origin = request.headers.get("origin");
  if (origin) {
    const host = parseHostFromOrigin(origin);
    if (!host || !allowedHosts.has(host)) {
      return NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 }
      );
    }
    return null;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    const host = parseHostFromOrigin(referer);
    if (!host || !allowedHosts.has(host)) {
      return NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 }
      );
    }
    return null;
  }

  // No Origin and no Referer → allow (non-browser client)
  return null;
}

/**
 * Enforces CSRF protection for mutating requests by requiring a valid
 * same-origin Origin/Referer (via {@link assertSameOrigin}) AND a matching
 * double-submit CSRF token.
 *
 * Token source (matches existing mutating-route patterns):
 * - Header: `x-csrf-token`
 * - Cookie: `csrf_token`
 *
 * Safe methods (GET, HEAD, OPTIONS) bypass entirely.
 *
 * Returns a 403 NextResponse when rejected, or null when allowed.
 */
export function assertCsrf(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) {
    return null;
  }

  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = request.cookies.get("csrf_token")?.value;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return NextResponse.json(
      { error: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  return null;
}
