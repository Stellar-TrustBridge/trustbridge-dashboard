/**
 * Tests for Sentry release health helpers in src/lib/sentry.ts.
 *
 * Happy path: NEXT_PUBLIC_APP_VERSION set → resolveRelease returns it,
 *             buildReleaseTag formats correctly.
 * Failure path 1: NEXT_PUBLIC_APP_VERSION absent but VERCEL_GIT_COMMIT_SHA
 *                 set → SHA is used as release.
 * Failure path 2: neither env var set → resolveRelease returns "unknown".
 * Failure path 3: blank / whitespace-only env var → treated as absent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRelease, buildReleaseTag } from "@/lib/sentry";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("resolveRelease — NEXT_PUBLIC_APP_VERSION is set", () => {
  it("returns NEXT_PUBLIC_APP_VERSION when it is set", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    expect(resolveRelease()).toBe("1.4.2");
  });

  it("prefers NEXT_PUBLIC_APP_VERSION over VERCEL_GIT_COMMIT_SHA", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "2026-11-24";
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123def456";

    expect(resolveRelease()).toBe("2026-11-24");
  });

  it("trims whitespace from NEXT_PUBLIC_APP_VERSION", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "  1.5.0  ";
    expect(resolveRelease()).toBe("1.5.0");
  });
});

describe("buildReleaseTag — NEXT_PUBLIC_APP_VERSION is set", () => {
  it("prefixes the version with the project name", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.4.2";
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    expect(buildReleaseTag()).toBe("trustbridge-dashboard@1.4.2");
  });
});

// ---------------------------------------------------------------------------
// Failure path 1: fallback to commit SHA
// ---------------------------------------------------------------------------
describe("resolveRelease — fallback to VERCEL_GIT_COMMIT_SHA", () => {
  it("uses VERCEL_GIT_COMMIT_SHA when NEXT_PUBLIC_APP_VERSION is absent", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.VERCEL_GIT_COMMIT_SHA = "deadbeef1234567890abcdef";

    expect(resolveRelease()).toBe("deadbeef1234567890abcdef");
  });

  it("builds a valid release tag from the commit SHA", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.VERCEL_GIT_COMMIT_SHA = "deadbeef1234";

    expect(buildReleaseTag()).toBe("trustbridge-dashboard@deadbeef1234");
  });
});

// ---------------------------------------------------------------------------
// Failure path 2: no env vars — returns "unknown"
// ---------------------------------------------------------------------------
describe("resolveRelease — no env vars configured", () => {
  it('returns "unknown" when neither env var is set', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    expect(resolveRelease()).toBe("unknown");
  });

  it('buildReleaseTag returns the "unknown" tag', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    expect(buildReleaseTag()).toBe("trustbridge-dashboard@unknown");
  });
});

// ---------------------------------------------------------------------------
// Failure path 3: blank / whitespace-only values
// ---------------------------------------------------------------------------
describe("resolveRelease — blank env var values", () => {
  it('falls through to VERCEL_GIT_COMMIT_SHA when NEXT_PUBLIC_APP_VERSION is blank', () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "   ";
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";

    expect(resolveRelease()).toBe("abc123");
  });

  it('returns "unknown" when both env vars are blank', () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "";
    process.env.VERCEL_GIT_COMMIT_SHA = "  ";

    expect(resolveRelease()).toBe("unknown");
  });
});
