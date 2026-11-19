import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    registration: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/registrations", () => ({
  toContributorRow: vi.fn((row: unknown) => row),
}));

vi.mock("@/lib/stale-export", () => ({
  buildStalenessSummary: vi.fn(),
}));

// Mock global fetch for Horizon + RPC probes
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { parseHealthResponse, runHealthChecks } from "@/lib/health";
import type { HealthResponse } from "@/app/api/health/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freshSummary() {
  return {
    stale: false,
    staleCount: 0,
    totalCount: 5,
    stalePercent: 0,
    warning: "",
    allowExport: true,
  };
}

function staleSummary() {
  return {
    stale: true,
    staleCount: 2,
    totalCount: 5,
    stalePercent: 40,
    warning: "2 of 5 contributors (40%) have not been verified in the last 24 hour(s).",
    allowExport: false,
  };
}

/** Make both Horizon and RPC probes succeed */
function mockProbesOk() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("fee_stats")) {
      return Promise.resolve({ ok: true });
    }
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { status: "healthy" } }),
      });
    }
    return Promise.resolve({ ok: false });
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /api/health", () => {
  it("returns 200 with status=ok when all checks pass", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.checks.database.status).toBe("ok");
    expect(json.checks.horizon.status).toBe("ok");
    expect(json.checks.sorobanRpc.status).toBe("ok");
    expect(json.checks.csvStaleness.status).toBe("ok");
    expect(json.timestamp).toBeTruthy();
    expect(json.version).toBeTruthy();
  });

  it("returns degraded when Horizon probe fails", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("fee_stats")) {
        return Promise.reject(new Error("timeout"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { status: "healthy" } }),
      });
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(json.status).toBe("degraded");
    expect(json.checks.horizon.status).toBe("degraded");
    expect(json.checks.sorobanRpc.status).toBe("ok");
  });

  it("returns degraded when Soroban RPC probe fails", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("fee_stats")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error("timeout"));
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(json.status).toBe("degraded");
    expect(json.checks.sorobanRpc.status).toBe("degraded");
    expect(json.checks.horizon.status).toBe("ok");
  });

  it("returns degraded when CSV data is stale", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(staleSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("degraded");
    expect(json.checks.csvStaleness.status).toBe("degraded");
    expect(json.checks.csvStaleness.staleCount).toBe(2);
    expect(json.checks.csvStaleness.stalePercent).toBe(40);
  });

  it("returns error when DB is unreachable", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("Connection refused"));

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("error");
    expect(json.checks.database.status).toBe("error");
    expect(json.checks.database.error).toContain("Connection refused");
    expect(prisma.registration.findMany).not.toHaveBeenCalled();
  });

  it("returns degraded when DB is healthy but staleness query fails", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.registration.findMany).mockRejectedValue(
      new Error("Query timeout")
    );

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(json.status).toBe("degraded");
    expect(json.checks.csvStaleness.warning).toContain("Unable to determine");
  });

  it("sets Cache-Control: public, max-age=30", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=30");
  });

  it("does not leak internal URLs or PII", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(staleSummary());

    const res = await GET();
    const text = await res.text();

    expect(text).not.toMatch(/postgresql:\/\//);
    expect(text).not.toContain("SOROBAN_RPC_URL");
    expect(text).not.toContain("NEXT_PUBLIC_HORIZON_URL");
    expect(text).not.toContain("githubUsername");
    expect(text).not.toContain("stellarAddress");
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("email");
  });

  it("horizon and sorobanRpc checks include non-negative latencyMs", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();

    expect(json.checks.horizon.latencyMs).toBeGreaterThanOrEqual(0);
    expect(json.checks.sorobanRpc.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include error field in database check when DB is healthy", async () => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());

    const res = await GET();
    const json: HealthResponse = await res.json();
    expect(json.checks.database.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Contract sync lag (issue #659)
// ---------------------------------------------------------------------------
describe("contract sync lag in health checks", () => {
  const STALL_MS = 60 * 60 * 1000;

  beforeEach(() => {
    mockProbesOk();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([] as never);
    vi.mocked(buildStalenessSummary).mockReturnValue(freshSummary());
  });

  it("keeps contract sync ok within the grace period (no successful run yet)", async () => {
    const json = await runHealthChecks({ now: Date.now() + 1_000 });

    expect(json.checks.contractSync.lag).toMatchObject({
      status: "ok",
      lagStatus: "ok",
      reason: "no_data",
    });
    expect(json.checks.contractSync.status).toBe("ok");
    expect(json.status).toBe("ok");
  });

  it("degrades overall health when no sync has succeeded past the stall threshold", async () => {
    const json = await runHealthChecks({ now: Date.now() + STALL_MS + 60_000 });

    expect(json.checks.contractSync.lag.lagStatus).toBe("stalled");
    expect(json.checks.contractSync.lag.reason).toBe("never_succeeded");
    expect(json.checks.contractSync.lag.stallThresholdMs).toBe(STALL_MS);
    expect(json.checks.contractSync.status).toBe("degraded");
    expect(json.status).toBe("degraded");
    expect(json.checks.database.status).toBe("ok");
  });

  it("parseHealthResponse preserves a well-formed lag block", () => {
    const parsed = parseHealthResponse({
      status: "degraded",
      timestamp: "2026-01-01T00:00:00.000Z",
      checks: {
        contractSync: {
          status: "degraded",
          lastRunAt: "2026-01-01T00:00:00.000Z",
          lag: {
            status: "degraded",
            lagStatus: "lagging",
            reason: "sync_delayed",
            sinceLastSuccessMs: 1_200_000,
            sinceLastCursorAdvanceMs: null,
            thresholdMs: 900_000,
            stallThresholdMs: 3_600_000,
            cursor: "ledger-7",
          },
        },
      },
      version: "0.1.0",
    });

    expect(parsed?.checks.contractSync.lag).toEqual({
      status: "degraded",
      lagStatus: "lagging",
      reason: "sync_delayed",
      sinceLastSuccessMs: 1_200_000,
      sinceLastCursorAdvanceMs: null,
      thresholdMs: 900_000,
      stallThresholdMs: 3_600_000,
      cursor: "ledger-7",
    });
  });

  it("parseHealthResponse coerces a payload without a lag block to ok", () => {
    const parsed = parseHealthResponse({
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      checks: { contractSync: { status: "ok", lastRunAt: null } },
      version: "0.1.0",
    });

    expect(parsed?.checks.contractSync.lag).toMatchObject({
      status: "ok",
      lagStatus: "ok",
      reason: "no_data",
      sinceLastSuccessMs: null,
      cursor: null,
    });
  });
});
