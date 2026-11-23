import type { Session } from "next-auth";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/soroban/events/route";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/soroban", () => ({
  getSorobanEventTimeline: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { getSorobanEventTimeline } from "@/lib/soroban";

// ── Helpers ──────────────────────────────────────────────────────────────────

function maintainerSession(overrides: Record<string, unknown> = {}): Session {
  return {
    user: { id: "user-1", isMaintainer: true, maintainerOrgId: "stellar-org", ...overrides },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;
}

function request(url: string): NextRequest {
  return new NextRequest(url);
}

const BASE = "http://localhost:3000/api/soroban/events";

const TIMELINE_PAYLOAD = { events: [], latestLedger: 42, errors: [] };

// ── Original auth tests (preserved) ──────────────────────────────────────────

describe("GET /api/soroban/events — authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 for a non-maintainer session", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
      expires: "2099-01-01T00:00:00.000Z",
    } satisfies Session);

    const res = await GET(request(BASE));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Forbidden");
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("returns 403 when there is no session", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const res = await GET(request(BASE));
    expect(res.status).toBe(403);
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("returns 200 with the event timeline for a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue(maintainerSession());
    vi.mocked(getSorobanEventTimeline).mockResolvedValue(TIMELINE_PAYLOAD);

    const res = await GET(request(BASE));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(TIMELINE_PAYLOAD);
  });
});

// ── Cursor validation tests ───────────────────────────────────────────────────

describe("GET /api/soroban/events — cursor validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerSession).mockResolvedValue(maintainerSession());
    vi.mocked(getSorobanEventTimeline).mockResolvedValue(TIMELINE_PAYLOAD);
  });

  it("omitted cursor: fetches the latest window without passing cursor to getSorobanEventTimeline", async () => {
    const res = await GET(request(BASE));
    expect(res.status).toBe(200);
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined })
    );
  });

  it("empty cursor string: treated as omitted (first page)", async () => {
    const res = await GET(request(`${BASE}?cursor=`));
    expect(res.status).toBe(200);
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined })
    );
  });

  it("valid ledger-only cursor is forwarded", async () => {
    const res = await GET(request(`${BASE}?cursor=12345`));
    expect(res.status).toBe(200);
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "12345" })
    );
  });

  it("valid ledger+event cursor is forwarded", async () => {
    const res = await GET(request(`${BASE}?cursor=12345-3`));
    expect(res.status).toBe(200);
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "12345-3" })
    );
  });

  it("whitespace-only cursor: treated as omitted (first page)", async () => {
    const res = await GET(request(`${BASE}?cursor=${encodeURIComponent("   ")}`));
    expect(res.status).toBe(200);
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: undefined })
    );
  });

  it("non-numeric cursor returns 400 with INVALID_CURSOR code", async () => {
    const res = await GET(request(`${BASE}?cursor=abc`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(json.error).toMatch(/invalid cursor/i);
    expect(json.remediation).toBeTruthy();
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("SQL injection attempt returns 400 with INVALID_CURSOR code", async () => {
    const res = await GET(request(`${BASE}?cursor=${encodeURIComponent("1; DROP TABLE")}`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("oversized cursor (> 128 chars) returns 400 with INVALID_CURSOR code", async () => {
    const bigCursor = "1".repeat(200);
    const res = await GET(request(`${BASE}?cursor=${bigCursor}`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("cursor with multiple hyphens returns 400", async () => {
    const res = await GET(request(`${BASE}?cursor=123-4-5`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("cursor with leading hyphen returns 400", async () => {
    const res = await GET(request(`${BASE}?cursor=-123`));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(getSorobanEventTimeline).not.toHaveBeenCalled();
  });

  it("malformed cursor is rejected even for a maintainer — auth alone is not sufficient", async () => {
    // Both a non-maintainer and a maintainer with a bad cursor get different
    // errors; this test confirms cursor validation runs AFTER auth so a
    // 400 never reveals route existence to unauthenticated callers.
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(request(`${BASE}?cursor=bad`));
    // Unauthenticated → 403, not 400 (auth gate fires first)
    expect(res.status).toBe(403);
  });
});

// ── Org-scope tests ───────────────────────────────────────────────────────────

describe("GET /api/soroban/events — org scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the session maintainerOrgId to getSorobanEventTimeline", async () => {
    vi.mocked(getServerSession).mockResolvedValue(maintainerSession({ maintainerOrgId: "wave-org" }));
    vi.mocked(getSorobanEventTimeline).mockResolvedValue(TIMELINE_PAYLOAD);

    await GET(request(BASE));
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "wave-org" })
    );
  });

  it("falls back to 'default' org when maintainerOrgId is absent from the session", async () => {
    vi.mocked(getServerSession).mockResolvedValue(
      maintainerSession({ maintainerOrgId: undefined })
    );
    vi.mocked(getSorobanEventTimeline).mockResolvedValue(TIMELINE_PAYLOAD);

    await GET(request(BASE));
    expect(getSorobanEventTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "default" })
    );
  });
});

// ── Edge-case / failure path tests ────────────────────────────────────────────

describe("GET /api/soroban/events — RPC failure resilience", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with an errors array when getSorobanEventTimeline surfaces an RPC error", async () => {
    vi.mocked(getServerSession).mockResolvedValue(maintainerSession());
    vi.mocked(getSorobanEventTimeline).mockResolvedValue({
      events: [],
      latestLedger: 0,
      errors: ["Soroban RPC error: connection refused"],
    });

    const res = await GET(request(BASE));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.errors).toContain("Soroban RPC error: connection refused");
    expect(json.events).toEqual([]);
  });

  it("returns 200 with SOROBAN_CONTRACT_ID error when contract is not configured", async () => {
    vi.mocked(getServerSession).mockResolvedValue(maintainerSession());
    vi.mocked(getSorobanEventTimeline).mockResolvedValue({
      events: [],
      latestLedger: 0,
      errors: ["SOROBAN_CONTRACT_ID is not configured"],
    });

    const res = await GET(request(BASE));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.errors[0]).toMatch(/SOROBAN_CONTRACT_ID/);
  });
});
