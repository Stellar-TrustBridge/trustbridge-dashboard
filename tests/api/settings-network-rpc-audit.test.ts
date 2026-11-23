/**
 * Tests for the dual-write RPC URL change audit on GET /api/settings/network.
 *
 * Happy path: maintainer GETs while Horizon URL changes → audit fired with
 * old/new values and credentials redacted.
 * Failure path 1: network mismatch still fires the existing mismatch audit.
 * Failure path 2: no audit when URLs have not changed since last read.
 * Failure path 3: credentials in RPC URL are stripped before logging.
 * Failure path 4: non-maintainer → 403, no audit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { recordAuditLog } from "@/lib/audit";
import { GET, _resetRpcState } from "@/app/api/settings/network/route";

const ORIGINAL_ENV = { ...process.env };

function setMaintainer() {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: "user-1", isMaintainer: true, githubUsername: "octocat" },
  } as never);
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetRpcState();
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.clearAllMocks();
  _resetRpcState();
});

// ---------------------------------------------------------------------------
// Happy path: RPC URL change is audited with old/new values
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — RPC URL change audit", () => {
  it("fires settings.network.rpc_url_changed when Horizon URL changes between requests", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    // First request — establishes the baseline, no change audit yet
    const first = await GET();
    expect(first.status).toBe(200);

    // Simulate a redeploy: Horizon URL changed to mainnet
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";

    vi.clearAllMocks();
    setMaintainer();

    const second = await GET();
    expect(second.status).toBe(200);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.network.rpc_url_changed",
        targetLabel: "network-config",
        metadata: expect.objectContaining({
          horizonUrl: {
            from: "https://horizon-testnet.stellar.org",
            to: "https://horizon.stellar.org",
          },
        }),
      })
    );
  });

  it("fires settings.network.rpc_url_changed when Soroban RPC URL changes", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    await GET();

    process.env.SOROBAN_RPC_URL = "https://mainnet.sorobanrpc.com";

    vi.clearAllMocks();
    setMaintainer();

    await GET();

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.network.rpc_url_changed",
        metadata: expect.objectContaining({
          sorobanUrl: {
            from: "https://soroban-testnet.stellar.org",
            to: "https://mainnet.sorobanrpc.com",
          },
        }),
      })
    );
  });

  it("includes actor identity on the RPC change audit entry", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    await GET();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    vi.clearAllMocks();
    setMaintainer();

    await GET();

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        actorLogin: "octocat",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// No change audit when URLs are stable
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — no audit when URLs unchanged", () => {
  it("does not fire rpc_url_changed on the first request (no baseline to compare against)", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://mainnet.sorobanrpc.com";

    await GET();

    // Only mismatch audit may fire (if mismatched), never the change audit on first call
    const changeCalls = vi
      .mocked(recordAuditLog)
      .mock.calls.filter(
        (c) => c[0].action === "settings.network.rpc_url_changed"
      );
    expect(changeCalls).toHaveLength(0);
  });

  it("does not fire rpc_url_changed on consecutive requests with identical URLs", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    await GET();
    vi.clearAllMocks();
    setMaintainer();

    await GET(); // same URLs — no change audit

    const changeCalls = vi
      .mocked(recordAuditLog)
      .mock.calls.filter(
        (c) => c[0].action === "settings.network.rpc_url_changed"
      );
    expect(changeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credential redaction in audit
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — credentials are redacted in audit", () => {
  it("strips inline credentials from the Horizon URL before logging", async () => {
    setMaintainer();
    // Set a URL with credentials in it (unusual but must be handled safely)
    process.env.NEXT_PUBLIC_HORIZON_URL =
      "https://admin:secret@horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    // First call: establish baseline with the credentialled URL
    await GET();

    // Change to a credential-free URL
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    vi.clearAllMocks();
    setMaintainer();

    await GET();

    const changeCalls = vi
      .mocked(recordAuditLog)
      .mock.calls.filter(
        (c) => c[0].action === "settings.network.rpc_url_changed"
      );
    expect(changeCalls).toHaveLength(1);

    const metadata = changeCalls[0][0].metadata as Record<string, unknown>;
    const horizonUrl = metadata.horizonUrl as { from: string; to: string };

    // The "from" value must NOT contain "secret"
    expect(horizonUrl.from).not.toContain("secret");
    expect(horizonUrl.from).not.toContain("admin");
    // But the host must still be present so the audit is useful
    expect(horizonUrl.from).toContain("horizon.stellar.org");
  });
});

// ---------------------------------------------------------------------------
// Existing mismatch audit is still fired
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — mismatch audit still fires", () => {
  it("fires network_config_mismatch_detected when networks disagree", async () => {
    setMaintainer();
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    await GET();

    const mismatchCalls = vi
      .mocked(recordAuditLog)
      .mock.calls.filter(
        (c) => c[0].action === "network_config_mismatch_detected"
      );
    expect(mismatchCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — auth guard", () => {
  it("returns 403 for a non-maintainer and fires no audit", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const res = await GET();
    expect(res.status).toBe(403);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for a session without isMaintainer and fires no audit", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "u1", isMaintainer: false },
    } as never);

    const res = await GET();
    expect(res.status).toBe(403);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No write handlers exist
// ---------------------------------------------------------------------------
describe("GET /api/settings/network — no write handlers", () => {
  it("does not expose POST, PUT, PATCH, or DELETE", async () => {
    const route = await import("@/app/api/settings/network/route");
    expect(route).not.toHaveProperty("POST");
    expect(route).not.toHaveProperty("PUT");
    expect(route).not.toHaveProperty("PATCH");
    expect(route).not.toHaveProperty("DELETE");
  });
});
