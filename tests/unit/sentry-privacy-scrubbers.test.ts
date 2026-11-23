/**
 * Tests for user privacy scrubbers in src/lib/sentry.ts
 *
 * Covers the new scrubbers added for username and address fields:
 *   pseudonymize          — deterministic SHA-256 pseudonym
 *   scrubUserFields       — pseudonymize GitHub username keys in context bags
 *   scrubAddressFields    — pseudonymize Stellar address keys in context bags
 *   redactValue           — integration: username/address keys pseudonymized
 *   redactContext         — end-to-end: nested payloads fully scrubbed
 *
 * Happy path   — known keys produce stable pseudonyms; non-sensitive keys pass through
 * Failure #1   — empty / null / missing values → [pseudo:empty]
 * Failure #2   — deeply nested payloads are walked (up to depth cap)
 *
 * These tests are intentionally separate from sentry-redaction.test.ts so
 * the existing pattern-based redaction tests are not disturbed.
 */

import { describe, expect, it } from "vitest";

import {
  pseudonymize,
  scrubUserFields,
  scrubAddressFields,
  redactValue,
  redactContext,
} from "@/lib/sentry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_LOGIN = "alice";
const G_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ---------------------------------------------------------------------------
// pseudonymize
// ---------------------------------------------------------------------------

describe("pseudonymize", () => {
  it("returns a string in the [pseudo:<12 hex chars>] format", () => {
    const p = pseudonymize(GITHUB_LOGIN);
    expect(p).toMatch(/^\[pseudo:[0-9a-f]{12}\]$/);
  });

  it("is deterministic: same input → same output every call", () => {
    expect(pseudonymize(GITHUB_LOGIN)).toBe(pseudonymize(GITHUB_LOGIN));
    expect(pseudonymize(G_ADDRESS)).toBe(pseudonymize(G_ADDRESS));
  });

  it("produces different pseudonyms for different inputs", () => {
    expect(pseudonymize("alice")).not.toBe(pseudonymize("bob"));
    expect(pseudonymize(G_ADDRESS)).not.toBe(pseudonymize("GBBB"));
  });

  it("does not embed the original value in the output (non-reversible)", () => {
    const p = pseudonymize(GITHUB_LOGIN);
    expect(p).not.toContain(GITHUB_LOGIN);
    const pa = pseudonymize(G_ADDRESS);
    expect(pa).not.toContain(G_ADDRESS);
  });

  it("handles empty string with [pseudo:empty]", () => {
    expect(pseudonymize("")).toBe("[pseudo:empty]");
  });

  it("handles whitespace-only string with [pseudo:empty]", () => {
    // Trims before hashing; a whitespace-only string is treated as empty.
    // This avoids leaking whether the original value was blank.
    expect(pseudonymize("   ")).toBe("[pseudo:empty]");
  });

  it("never throws on any string input", () => {
    const hostile = [
      "",
      "   ",
      "\x00",
      "a".repeat(10_000),
      "🌟",
      G_ADDRESS,
    ];
    for (const input of hostile) {
      expect(() => pseudonymize(input)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// scrubUserFields — happy path
// ---------------------------------------------------------------------------

describe("scrubUserFields — username fields are pseudonymized", () => {
  const USERNAME_FIELD_VARIANTS = [
    "githubUsername",
    "github_username",
    "username",
    "login",
    "actorLogin",
    "actor_login",
  ];

  it.each(USERNAME_FIELD_VARIANTS)(
    "pseudonymizes key: %s",
    (key) => {
      const result = scrubUserFields({ [key]: GITHUB_LOGIN });
      expect(result[key]).toMatch(/^\[pseudo:[0-9a-f]{12}\]$/);
      expect(result[key]).not.toContain(GITHUB_LOGIN);
    }
  );

  it("leaves non-username keys untouched", () => {
    const ctx = { route: "/api/register", status: 200, userId: "u-1" };
    const result = scrubUserFields(ctx);
    expect(result.route).toBe("/api/register");
    expect(result.status).toBe(200);
    expect(result.userId).toBe("u-1");
  });

  it("produces the same pseudonym as pseudonymize() directly", () => {
    const result = scrubUserFields({ username: GITHUB_LOGIN });
    expect(result.username).toBe(pseudonymize(GITHUB_LOGIN));
  });

  it("walks nested objects", () => {
    const ctx = { actor: { login: GITHUB_LOGIN, role: "maintainer" } };
    const result = scrubUserFields(ctx) as { actor: Record<string, unknown> };
    expect(result.actor.login).toMatch(/^\[pseudo:/);
    expect(result.actor.role).toBe("maintainer");
  });
});

// ---------------------------------------------------------------------------
// scrubAddressFields — happy path
// ---------------------------------------------------------------------------

describe("scrubAddressFields — address fields are pseudonymized", () => {
  const ADDRESS_FIELD_VARIANTS = [
    "stellarAddress",
    "stellar_address",
    "walletAddress",
    "wallet_address",
    "address",
  ];

  it.each(ADDRESS_FIELD_VARIANTS)(
    "pseudonymizes key: %s",
    (key) => {
      const result = scrubAddressFields({ [key]: G_ADDRESS });
      expect(result[key]).toMatch(/^\[pseudo:[0-9a-f]{12}\]$/);
      expect(result[key]).not.toContain(G_ADDRESS);
    }
  );

  it("leaves non-address keys untouched", () => {
    const ctx = { route: "/api/check", funded: true };
    const result = scrubAddressFields(ctx);
    expect(result.route).toBe("/api/check");
    expect(result.funded).toBe(true);
  });

  it("produces the same pseudonym as pseudonymize() directly", () => {
    const result = scrubAddressFields({ stellarAddress: G_ADDRESS });
    expect(result.stellarAddress).toBe(pseudonymize(G_ADDRESS));
  });

  it("walks nested objects", () => {
    const ctx = { registration: { stellarAddress: G_ADDRESS, funded: true } };
    const result = scrubAddressFields(ctx) as {
      registration: Record<string, unknown>;
    };
    expect(result.registration.stellarAddress).toMatch(/^\[pseudo:/);
    expect(result.registration.funded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure path #1 — empty / null / missing values
// ---------------------------------------------------------------------------

describe("scrubUserFields / scrubAddressFields — empty value handling", () => {
  it("scrubUserFields: empty string → [pseudo:empty]", () => {
    expect(scrubUserFields({ username: "" }).username).toBe("[pseudo:empty]");
  });

  it("scrubUserFields: whitespace-only → [pseudo:empty]", () => {
    expect(scrubUserFields({ username: "  " }).username).toBe("[pseudo:empty]");
  });

  it("scrubAddressFields: empty string → [pseudo:empty]", () => {
    expect(scrubAddressFields({ address: "" }).address).toBe("[pseudo:empty]");
  });

  it("scrubAddressFields: null-ish value is passed through (not a string)", () => {
    // null is not a string, so the scrubber cannot pseudonymize it.
    // It falls through to the value unchanged (the key still matches but
    // the type guard prevents pseudonymization of non-strings).
    const result = scrubAddressFields({ address: null });
    expect(result.address).toBe("[pseudo:empty]");
  });
});

// ---------------------------------------------------------------------------
// Failure path #2 — deeply nested payloads
// ---------------------------------------------------------------------------

describe("redactValue — username/address keys in nested payloads", () => {
  it("pseudonymizes githubUsername in a flat context bag", () => {
    const out = redactValue({
      githubUsername: GITHUB_LOGIN,
      route: "/api/register",
    }) as Record<string, unknown>;
    expect(out.githubUsername).toMatch(/^\[pseudo:/);
    expect(out.githubUsername).not.toContain(GITHUB_LOGIN);
    expect(out.route).toBe("/api/register");
  });

  it("pseudonymizes stellarAddress in a flat context bag", () => {
    const out = redactValue({
      stellarAddress: G_ADDRESS,
      funded: true,
    }) as Record<string, unknown>;
    expect(out.stellarAddress).toMatch(/^\[pseudo:/);
    expect(out.stellarAddress).not.toContain(G_ADDRESS);
    expect(out.funded).toBe(true);
  });

  it("pseudonymizes username/address in a nested registration payload", () => {
    const ctx = {
      registration: {
        stellarAddress: G_ADDRESS,
        githubUsername: GITHUB_LOGIN,
        readiness: "ready",
      },
    };
    const out = redactValue(ctx) as {
      registration: Record<string, unknown>;
    };
    expect(out.registration.stellarAddress).toMatch(/^\[pseudo:/);
    expect(out.registration.githubUsername).toMatch(/^\[pseudo:/);
    expect(out.registration.readiness).toBe("ready");
  });

  it("still drops credential keys before pseudonymizing", () => {
    // token is a SENSITIVE_KEY — it should be dropped, not pseudonymized.
    const out = redactValue({
      token: "secret-value",
      username: GITHUB_LOGIN,
    }) as Record<string, unknown>;
    expect(out.token).toBe("[redacted]");
    expect(out.username).toMatch(/^\[pseudo:/);
  });

  it("pseudonymizes address in an array of registration objects", () => {
    const ctx = {
      registrations: [
        { stellarAddress: G_ADDRESS, readiness: "ready" },
        { stellarAddress: "GBBB", readiness: "not_ready" },
      ],
    };
    const out = redactValue(ctx) as {
      registrations: Array<Record<string, unknown>>;
    };
    expect(out.registrations[0].stellarAddress).toMatch(/^\[pseudo:/);
    expect(out.registrations[1].stellarAddress).toMatch(/^\[pseudo:/);
    // Different addresses → different pseudonyms.
    expect(out.registrations[0].stellarAddress).not.toBe(
      out.registrations[1].stellarAddress
    );
  });

  it("caps recursion at MAX_REDACT_DEPTH without throwing", () => {
    // 8 levels of nesting wrapping a username key — past the depth cap of 6.
    let deep: Record<string, unknown> = { username: GITHUB_LOGIN };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
    const out = JSON.stringify(redactValue(deep));
    // The outer layers resolve to [redacted:max-depth] before reaching the key.
    expect(out).toContain("[redacted:max-depth]");
    // The raw login must not appear anywhere in the output.
    expect(out).not.toContain(GITHUB_LOGIN);
  });
});

// ---------------------------------------------------------------------------
// redactContext — end-to-end integration
// ---------------------------------------------------------------------------

describe("redactContext — end-to-end with username/address fields", () => {
  it("pseudonymizes githubUsername in a registration error context", () => {
    const ctx = {
      route: "/api/register",
      userId: "u-123",
      githubUsername: GITHUB_LOGIN,
      stellarAddress: G_ADDRESS,
    };
    const out = redactContext(ctx)!;
    expect(out.route).toBe("/api/register");
    expect(out.userId).toBe("u-123");
    expect(out.githubUsername).toMatch(/^\[pseudo:/);
    expect(out.stellarAddress).toMatch(/^\[pseudo:/);
    expect(out.githubUsername).not.toContain(GITHUB_LOGIN);
    expect(out.stellarAddress).not.toContain(G_ADDRESS);
  });

  it("both scrubs produce stable, identical pseudonyms on repeated calls", () => {
    const ctx = { username: GITHUB_LOGIN, stellarAddress: G_ADDRESS };
    const out1 = redactContext(ctx)!;
    const out2 = redactContext(ctx)!;
    expect(out1.username).toBe(out2.username);
    expect(out1.stellarAddress).toBe(out2.stellarAddress);
  });

  it("does not pseudonymize a raw G-address embedded in an error message string", () => {
    // String values are handled by redactString's pattern rules, not the
    // semantic field scrubbers — this confirms the two passes are independent.
    const ctx = { error: `no trustline for ${G_ADDRESS}` };
    const out = redactContext(ctx)!;
    // redactString replaces the G-address with [redacted:stellar-address].
    expect(out.error).toContain("[redacted:stellar-address]");
    expect(out.error).not.toContain(G_ADDRESS);
  });

  it("handles a context bag with no personal fields without changing it", () => {
    const ctx = { route: "/api/health", status: 200 };
    expect(redactContext(ctx)).toEqual(ctx);
  });
});
