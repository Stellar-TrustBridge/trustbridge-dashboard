import { NextResponse } from "next/server";

import type { HorizonCheckResult, ReadinessStatus } from "@/types";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "@/lib/circuit-breaker";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const HORIZON_BREAKER_NAME = "horizon";
export const SOROBAN_BREAKER_NAME = "soroban";

/**
 * Shared circuit breakers guarding outbound Stellar calls. A single breaker
 * per upstream keeps state consistent across requests so a Horizon or Soroban
 * outage trips once and short-circuits subsequent calls instead of cascading.
 */
export const horizonBreaker = new CircuitBreaker();
export const sorobanBreaker = new CircuitBreaker();

/**
 * Stable reason codes emitted when a configurable Action/check base URL fails
 * SSRF validation. Kept as a closed set so operators and tests can assert on
 * them without parsing free-form messages.
 */
export type CheckBaseUrlReasonCode =
  | "invalid_url"
  | "disallowed_scheme"
  | "embedded_credentials"
  | "disallowed_port"
  | "disallowed_host";

export interface CheckBaseUrlValidation {
  ok: boolean;
  reason?: CheckBaseUrlReasonCode;
  message?: string;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * Hostnames that must never be reachable from a configurable base URL. These
 * cover loopback, link-local/metadata, and internal service discovery names.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

function isPrivateOrReservedIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIPv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true; // unique local
  }
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — validate the embedded IPv4 address.
    return isPrivateOrReservedIPv4(normalized.slice("::ffff:".length));
  }
  return false;
}

/**
 * Validate a configurable Action/check base URL against the same SSRF posture
 * used by other outbound clients: scheme allowlist, no embedded credentials,
 * restricted ports, and rejection of private/loopback/link-local/metadata
 * hosts. Returns a stable reason code on rejection.
 */
export function validateCheckBaseUrl(raw: string): CheckBaseUrlValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "invalid_url",
      message: "Action base URL is empty.",
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "invalid_url",
      message: "Action base URL is malformed.",
    };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      reason: "disallowed_scheme",
      message: `Action base URL scheme "${url.protocol}" is not allowed.`,
    };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      reason: "embedded_credentials",
      message: "Action base URL must not embed credentials.",
    };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return {
      ok: false,
      reason: "disallowed_port",
      message: `Action base URL port "${url.port}" is not allowed.`,
    };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) {
    return {
      ok: false,
      reason: "invalid_url",
      message: "Action base URL is missing a host.",
    };
  }

  const isIPv6 = hostname.startsWith("[") || hostname.includes(":");
  const blocked =
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (isIPv6 ? isBlockedIPv6(hostname) : isPrivateOrReservedIPv4(hostname));

  if (blocked) {
    return {
      ok: false,
      reason: "disallowed_host",
      message: "Action base URL host is not allowed.",
    };
  }

  return { ok: true };
}

export function emptyCheckResult(
  readiness: ReadinessStatus = "not_ready",
  errors: string[] = [],
): HorizonCheckResult {
  return {
    funded: false,
    trustline: false,
    trustline_authorized: false,
    verified: false,
    xlm_balance: "0",
    spendable_xlm_balance: "0",
    usdc_balance: "0",
    errors,
    readiness,
  };
}

/**
 * Run an outbound Horizon call through the shared breaker. When the breaker is
 * open (or the upstream fails) a stable, actionable error is surfaced instead
 * of letting the failure cascade through the dashboard.
 */
export async function withHorizonBreaker<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return horizonBreaker.call(fn);
}

/**
 * Run an outbound Soroban call through the shared breaker. Mirrors
 * {@link withHorizonBreaker} so both upstreams degrade identically.
 */
export async function withSorobanBreaker<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return sorobanBreaker.call(fn);
}

/**
 * Map a breaker/upstream failure to a stable, user-facing message. Open
 * breakers report a degraded state so the UI can show a retry hint rather than
 * a generic 500.
 */
export function describeBreakerError(error: unknown): {
  message: string;
  degraded: boolean;
} {
  if (error instanceof CircuitBreakerOpenError) {
    return {
      message:
        "Stellar network is temporarily unavailable. Please retry shortly.",
      degraded: true,
    };
  }
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Stellar network request failed.";
  return { message, degraded: false };
}

/**
 * Read the idempotency key supplied by the check-api client on mutation
 * requests (e.g. recheck). Returns a trimmed key or null when absent/blank so
 * callers can reject malformed input with a stable error.
 */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  return key.length > 0 ? key : null;
}

export function jsonCheckError(
  errors: string[],
  status: number,
  readiness: ReadinessStatus = "not_ready",
  headers?: HeadersInit
) {
  return NextResponse.json(emptyCheckResult(readiness, errors), {
    status,
    ...(headers ? { headers } : {}),
  });
}

export function jsonCheckResult(
  result: HorizonCheckResult,
  status = 200,
  headers?: HeadersInit
) {
  return NextResponse.json(result, {
    status,
    ...(headers ? { headers } : {}),
  });
}
