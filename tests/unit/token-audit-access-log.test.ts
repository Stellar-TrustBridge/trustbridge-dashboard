/**
 * Tests for API-key access log (token-audit #695).
 *
 * Verifies that `authenticateApiKey` writes an `api_key.used` audit log
 * entry on every successful authentication, that the entry never contains
 * raw key material, and that lifecycle-failure paths (revoked, expired, bad
 * token) continue to write `api_key.use_rejected` without also writing
 * `api_key.used`.
 *
 * Happy path  — valid active key → `api_key.used` written with key id, name,
 *               route, and outcome=allowed; raw token never logged.
 * Failure paths:
 *   1. Revoked key  → `api_key.use_rejected` (reason=revoked), no `api_key.used`.
 *   2. Expired key  → `api_key.use_rejected` (reason=expired), no `api_key.used`.
 *   3. No/bad token → returns null, no audit writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { authenticateApiKey } from "@/lib/api-key-auth";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A well-formed key that passes `isValidApiKeyFormat`. */
const RAW_KEY = `tb_${"A".repeat(43)}`;

function makeRequest(
  raw: string = RAW_KEY,
  path: string = "/api/contributors/export/csv"
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${raw}` },
  });
}

function activeDbKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-audit-1",
    name: "nightly-export",
    scopes: ["export:read"],
    createdById: "maintainer-99",
    maintainerOrgId: "org-1",
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("authenticateApiKey — access log (happy path)", () => {
  it("writes api_key.used to the audit log on success", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const calls = vi.mocked(recordAuditLog).mock.calls;
    const usedEntry = calls.find(([arg]) => arg.action === "api_key.used");
    expect(usedEntry).toBeDefined();
  });

  it("sets actorLogin to 'api-key:<name>'", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].actorLogin).toBe("api-key:nightly-export");
  });

  it("sets targetId to the key's id", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].targetId).toBe("key-audit-1");
  });

  it("includes outcome=allowed in metadata", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].metadata?.outcome).toBe("allowed");
  });

  it("includes the route path in metadata", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest(RAW_KEY, "/api/treasury/export"));

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].metadata?.route).toContain("/api/treasury/export");
  });

  it("never includes the raw key token in any audit log field", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const allCalls = vi.mocked(recordAuditLog).mock.calls;
    const serialised = JSON.stringify(allCalls);
    // The raw key starts with "tb_" and is 46 chars — must never appear.
    expect(serialised).not.toContain(RAW_KEY);
    // No field named "token", "secret", "rawKey", "keyHash" either.
    expect(serialised).not.toMatch(/"token":/i);
    expect(serialised).not.toMatch(/"secret":/i);
    expect(serialised).not.toMatch(/"rawKey":/i);
    expect(serialised).not.toMatch(/"keyHash":/i);
  });

  it("includes keyId metadata matching the key record id", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].metadata?.keyId).toBe("key-audit-1");
  });

  it("sets actorId to createdById", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(activeDbKey() as never);

    await authenticateApiKey(makeRequest());

    const usedCall = vi.mocked(recordAuditLog).mock.calls.find(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCall?.[0].actorId).toBe("maintainer-99");
  });
});

// ── Failure path 1 — revoked key ─────────────────────────────────────────────

describe("authenticateApiKey — access log (revoked key)", () => {
  it("writes api_key.use_rejected with reason=revoked", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      activeDbKey({ revokedAt: new Date("2026-01-01") }) as never
    );

    const result = await authenticateApiKey(makeRequest());

    expect(result).toBeNull();

    const rejectedCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) => arg.action === "api_key.use_rejected"
    );
    expect(rejectedCalls).toHaveLength(1);
    expect(rejectedCalls[0][0].metadata?.reason).toBe("revoked");
  });

  it("does NOT write api_key.used when the key is revoked", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      activeDbKey({ revokedAt: new Date("2026-01-01") }) as never
    );

    await authenticateApiKey(makeRequest());

    const usedCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCalls).toHaveLength(0);
  });
});

// ── Failure path 2 — expired key ─────────────────────────────────────────────

describe("authenticateApiKey — access log (expired key)", () => {
  it("writes api_key.use_rejected with reason=expired", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      activeDbKey({ expiresAt: new Date("2020-06-01") }) as never
    );

    const result = await authenticateApiKey(makeRequest());

    expect(result).toBeNull();

    const rejectedCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) => arg.action === "api_key.use_rejected"
    );
    expect(rejectedCalls).toHaveLength(1);
    expect(rejectedCalls[0][0].metadata?.reason).toBe("expired");
  });

  it("does NOT write api_key.used when the key is expired", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(
      activeDbKey({ expiresAt: new Date("2020-06-01") }) as never
    );

    await authenticateApiKey(makeRequest());

    const usedCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) => arg.action === "api_key.used"
    );
    expect(usedCalls).toHaveLength(0);
  });
});

// ── Failure path 3 — missing or malformed token ───────────────────────────────

describe("authenticateApiKey — access log (no/bad token)", () => {
  it("returns null and writes no audit log when no Authorization header present", async () => {
    const result = await authenticateApiKey(
      new NextRequest("http://localhost:3000/api/contributors/export/csv")
    );

    expect(result).toBeNull();
    // No DB lookup means no audit writes for key lifecycle events.
    // The only valid audit writes here would be rate-limit rejections, but
    // the IP is "unknown" and within budget, so none fire.
    const keyCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) =>
        arg.action === "api_key.used" || arg.action === "api_key.use_rejected"
    );
    expect(keyCalls).toHaveLength(0);
  });

  it("returns null and writes no audit log for a malformed token", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/contributors/export/csv",
      { headers: { authorization: "Bearer not-a-valid-tb-key" } }
    );

    const result = await authenticateApiKey(req);

    expect(result).toBeNull();
    const keyCalls = vi.mocked(recordAuditLog).mock.calls.filter(
      ([arg]) =>
        arg.action === "api_key.used" || arg.action === "api_key.use_rejected"
    );
    expect(keyCalls).toHaveLength(0);
  });
});
