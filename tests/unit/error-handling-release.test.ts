/**
 * Tests for release-health helpers added to src/lib/error-handling.ts.
 *
 * Happy path: NEXT_PUBLIC_APP_VERSION set → getCurrentRelease / annotateWithRelease.
 * Failure path 1: fallback chain (SHA → "unknown").
 * Failure path 2: blank values fall through.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCurrentRelease, annotateWithRelease } from "@/lib/error-handling";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("getCurrentRelease", () => {
  it("returns NEXT_PUBLIC_APP_VERSION when set", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "2.0.0";
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(getCurrentRelease()).toBe("2.0.0");
  });

  it("falls back to VERCEL_GIT_COMMIT_SHA when APP_VERSION is absent", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.VERCEL_GIT_COMMIT_SHA = "sha123";
    expect(getCurrentRelease()).toBe("sha123");
  });

  it('returns "unknown" when neither var is set', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(getCurrentRelease()).toBe("unknown");
  });

  it("treats blank APP_VERSION as absent", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "   ";
    process.env.VERCEL_GIT_COMMIT_SHA = "sha456";
    expect(getCurrentRelease()).toBe("sha456");
  });
});

describe("annotateWithRelease", () => {
  it("adds x-dashboard-release header to the response", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    const response = new Response(null, { status: 200 });
    const annotated = annotateWithRelease(response);
    expect(annotated.headers.get("x-dashboard-release")).toBe("1.2.3");
  });

  it('sets header to "unknown" when no release is configured', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const response = new Response(null, { status: 500 });
    const annotated = annotateWithRelease(response);
    expect(annotated.headers.get("x-dashboard-release")).toBe("unknown");
  });

  it("preserves existing response status and headers", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "3.0.0";
    const response = new Response(JSON.stringify({ error: "oops" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const annotated = annotateWithRelease(response);
    expect(annotated.status).toBe(500);
    expect(annotated.headers.get("content-type")).toBe("application/json");
    expect(annotated.headers.get("x-dashboard-release")).toBe("3.0.0");
  });
});
