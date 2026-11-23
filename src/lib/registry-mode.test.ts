import { afterEach, describe, expect, it } from "vitest";

import { getRegistryMode } from "@/lib/registry-mode";

describe("getRegistryMode", () => {
  afterEach(() => {
    delete process.env.REGISTRY_MODE;
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  it("defaults to 'live' when unset", () => {
    expect(getRegistryMode()).toBe("live");
  });

  it("returns 'live' when explicitly set to 'live'", () => {
    process.env.REGISTRY_MODE = "live";
    expect(getRegistryMode()).toBe("live");
  });

  it("returns 'synced' when explicitly configured", () => {
    process.env.REGISTRY_MODE = "synced";
    expect(getRegistryMode()).toBe("synced");
  });

  // ── Normalisation ─────────────────────────────────────────────────────────

  it("is case-insensitive and trims whitespace", () => {
    process.env.REGISTRY_MODE = "  SYNCED  ";
    expect(getRegistryMode()).toBe("synced");
  });

  it("normalises uppercase LIVE to 'live'", () => {
    process.env.REGISTRY_MODE = "LIVE";
    expect(getRegistryMode()).toBe("live");
  });

  it("normalises mixed-case to 'synced'", () => {
    process.env.REGISTRY_MODE = "Synced";
    expect(getRegistryMode()).toBe("synced");
  });

  it("strips surrounding whitespace from 'live'", () => {
    process.env.REGISTRY_MODE = "  live  ";
    expect(getRegistryMode()).toBe("live");
  });

  it("strips surrounding whitespace from 'synced'", () => {
    process.env.REGISTRY_MODE = "\t synced \t";
    expect(getRegistryMode()).toBe("synced");
  });

  // ── Failure / fallback paths ──────────────────────────────────────────────

  it("falls back to 'live' for an unrecognized value instead of failing", () => {
    process.env.REGISTRY_MODE = "bogus";
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for an empty string (failure path)", () => {
    process.env.REGISTRY_MODE = "";
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for a whitespace-only string (failure path)", () => {
    process.env.REGISTRY_MODE = "   ";
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for a numeric string (failure path)", () => {
    process.env.REGISTRY_MODE = "1";
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for a near-match (failure path — typo guard)", () => {
    process.env.REGISTRY_MODE = "sync";   // missing the 'd'
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for a near-match with extra chars", () => {
    process.env.REGISTRY_MODE = "synced2";
    expect(getRegistryMode()).toBe("live");
  });

  it("falls back to 'live' for a JSON-like value (failure path)", () => {
    process.env.REGISTRY_MODE = '{"mode":"synced"}';
    expect(getRegistryMode()).toBe("live");
  });

  // ── Stability / idempotency ───────────────────────────────────────────────

  it("returns the same value on repeated calls without env changes (idempotent)", () => {
    process.env.REGISTRY_MODE = "synced";
    const first = getRegistryMode();
    const second = getRegistryMode();
    const third = getRegistryMode();
    expect(first).toBe("synced");
    expect(second).toBe("synced");
    expect(third).toBe("synced");
  });

  it("responds immediately to env var changes between calls", () => {
    process.env.REGISTRY_MODE = "live";
    expect(getRegistryMode()).toBe("live");

    process.env.REGISTRY_MODE = "synced";
    expect(getRegistryMode()).toBe("synced");

    delete process.env.REGISTRY_MODE;
    expect(getRegistryMode()).toBe("live");
  });

  // ── Type safety ───────────────────────────────────────────────────────────

  it("return value is exactly 'live' or 'synced' — never undefined", () => {
    process.env.REGISTRY_MODE = "anything-invalid";
    const mode = getRegistryMode();
    expect(mode === "live" || mode === "synced").toBe(true);
  });

  it("return value is a string in all cases", () => {
    for (const val of ["live", "synced", "LIVE", "", "bogus", undefined]) {
      if (val === undefined) {
        delete process.env.REGISTRY_MODE;
      } else {
        process.env.REGISTRY_MODE = val;
      }
      expect(typeof getRegistryMode()).toBe("string");
    }
  });

  // ── Missing env var (process.env key absent entirely) ────────────────────

  it("handles the key being completely absent (not just empty)", () => {
    // delete ensures the key is absent, not empty-string
    delete process.env.REGISTRY_MODE;
    expect(getRegistryMode()).toBe("live");
  });
});
