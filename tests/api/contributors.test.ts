import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/contributors/route";

vi.mock("@/lib/api-auth", () => ({
  refreshMaintainerSession: vi.fn(),
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/registrations", () => ({
  getContributors: vi.fn(),
  refreshAllContributors: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/background-queue", () => ({
  backgroundQueue: {
    enqueue: vi.fn(),
  },
}));

import {
  refreshMaintainerSession,
  requireMaintainerSession,
} from "@/lib/api-auth";
import { backgroundQueue } from "@/lib/background-queue";
import { getContributors, refreshAllContributors } from "@/lib/registrations";
import type { ContributorRow } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function makeContributor(
  id: string,
  readiness: ContributorRow["readiness"]
): ContributorRow {
  return {
    id,
    githubUsername: `user-${id}`,
    stellarAddress: `G${id.padEnd(55, "X")}`,
    trustlineReady: readiness !== "not_ready",
    trustlineAuthorized: readiness !== "not_ready",
    verified: readiness === "ready",
    funded: readiness !== "not_ready",
    xlmBalance: readiness === "low_reserve" ? "0.5" : "5",
    spendableXlmBalance: readiness === "low_reserve" ? "0.1" : "4",
    lastCheckedAt: new Date().toISOString(),
    readiness,
  };
}

const allContributors: ContributorRow[] = [
  makeContributor("1", "ready"),
  makeContributor("2", "ready"),
  makeContributor("3", "low_reserve"),
  makeContributor("4", "not_ready"),
  makeContributor("5", "low_reserve"),
];

function get(url: string, headers?: Record<string, string>) {
  return new NextRequest(url, {
    method: "GET",
    headers: headers ?? { host: "localhost:3000" },
  });
}

function post(headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/contributors", {
    method: "POST",
    headers: headers ?? sameOriginHeaders,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getContributors).mockResolvedValue({
    contributors: allContributors,
    total: allContributors.length,
  });
});

// ---------------------------------------------------------------------------
// GET — auth
// ---------------------------------------------------------------------------
describe("GET /api/contributors — auth", () => {
  it("returns 403 when unauthenticated", async () => {
    vi.mocked(refreshMaintainerSession).mockResolvedValue(null);
    const res = await GET(get("http://localhost:3000/api/contributors"));
    expect(res.status).toBe(403);
  });

  it("returns 403 when authenticated but not a maintainer", async () => {
    vi.mocked(refreshMaintainerSession).mockResolvedValue(null);
    const res = await GET(get("http://localhost:3000/api/contributors"));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET — no filter
// ---------------------------------------------------------------------------
describe("GET /api/contributors — no filter", () => {
  beforeEach(() => {
    vi.mocked(refreshMaintainerSession).mockResolvedValue({
      user: { id: "u-1", isMaintainer: true },
    } as never);
  });

  it("returns all contributors when no readiness param is provided", async () => {
    const res = await GET(get("http://localhost:3000/api/contributors"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributors).toHaveLength(5);
    expect(json.total).toBe(5);
    expect(json.filtered).toBe(5);
    expect(json.readiness).toBeUndefined();
    expect(json.registryMode).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// GET — readiness filter
// ---------------------------------------------------------------------------
describe("GET /api/contributors — readiness filter", () => {
  beforeEach(() => {
    vi.mocked(refreshMaintainerSession).mockResolvedValue({
      user: { id: "u-1", isMaintainer: true },
    } as never);
  });

  it("filters to only 'ready' contributors", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=ready")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributors).toHaveLength(2);
    expect(json.filtered).toBe(2);
    expect(json.total).toBe(5);
    expect(json.readiness).toBe("ready");
    for (const c of json.contributors) {
      expect(c.readiness).toBe("ready");
    }
  });

  it("filters to only 'low_reserve' contributors", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=low_reserve")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributors).toHaveLength(2);
    expect(json.filtered).toBe(2);
    expect(json.total).toBe(5);
    expect(json.readiness).toBe("low_reserve");
    for (const c of json.contributors) {
      expect(c.readiness).toBe("low_reserve");
    }
  });

  it("filters to only 'not_ready' contributors", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=not_ready")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributors).toHaveLength(1);
    expect(json.filtered).toBe(1);
    expect(json.total).toBe(5);
    expect(json.readiness).toBe("not_ready");
  });

  it("returns 400 for an invalid readiness value", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=invalid")
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid readiness filter");
    expect(json.error).toContain("invalid");
    expect(json.error).toContain("ready");
    expect(json.error).toContain("low_reserve");
    expect(json.error).toContain("not_ready");
  });

  it("returns 400 for readiness=READY (case-sensitive)", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=READY")
    );
    expect(res.status).toBe(400);
  });

  it("returns empty list when no contributors match the filter", async () => {
    vi.mocked(getContributors).mockResolvedValue({
      contributors: [makeContributor("1", "ready")],
      total: 1,
    });
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=low_reserve")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributors).toHaveLength(0);
    expect(json.filtered).toBe(0);
    expect(json.total).toBe(1);
  });

  it("returns total=0 and filtered=0 when no contributors exist", async () => {
    vi.mocked(getContributors).mockResolvedValue({
      contributors: [],
      total: 0,
    });
    const res = await GET(
      get("http://localhost:3000/api/contributors?readiness=low_reserve")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(0);
    expect(json.filtered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST — CSRF + auth
// ---------------------------------------------------------------------------
describe("POST /api/contributors", () => {
  it("rejects cross-origin with CSRF error before touching auth", async () => {
    const r = post({
      origin: "https://evil.com",
      host: "localhost:3000",
    });
    const res = await POST(r);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Invalid request origin");
    expect(requireMaintainerSession).not.toHaveBeenCalled();
  });

  it("returns 403 (auth) for same-origin non-maintainer", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
    const r = post();
    const res = await POST(r);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Forbidden");
    expect(refreshAllContributors).not.toHaveBeenCalled();
  });

  it("returns 200 for same-origin maintainer", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(backgroundQueue.enqueue).mockResolvedValue("job-batch-1");

    const r = post();
    const res = await POST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jobId).toBe("job-batch-1");
    expect(json.status).toBe("pending");
    expect(json.message).toMatch(/enqueued/i);
    expect(backgroundQueue.enqueue).toHaveBeenCalledWith(
      "recheck.batch",
      {},
      "user-1"
    );
    expect(refreshAllContributors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST — Idempotency & Horizon Stampede Protection
// ---------------------------------------------------------------------------
describe("POST /api/contributors — Idempotency & Horizon protection", () => {
  beforeEach(async () => {
    const { recheckLockCache } = await import("@/lib/cache");
    recheckLockCache.clear();
    vi.mocked(requireMaintainerSession).mockResolvedValue({
      user: { id: "maintainer-user-1", isMaintainer: true },
    } as any);
  });

  it("prevents double-click stampede by returning the same jobId within the window", async () => {
    vi.mocked(backgroundQueue.enqueue).mockResolvedValueOnce("job-batch-unique-1");

    const r1 = post();
    const res1 = await POST(r1);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.jobId).toBe("job-batch-unique-1");
    expect(json1.idempotent).toBe(false);

    // Second immediate click (double-click)
    const r2 = post();
    const res2 = await POST(r2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.jobId).toBe("job-batch-unique-1");
    expect(json2.idempotent).toBe(true);
    expect(res2.headers.get("X-Idempotent-Replay")).toBe("true");

    // Background queue was only enqueued once
    expect(backgroundQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("supports explicit Idempotency-Key header", async () => {
    vi.mocked(backgroundQueue.enqueue).mockResolvedValueOnce("job-idempotency-key-test");

    const headersWithKey = {
      ...sameOriginHeaders,
      "idempotency-key": "wave-batch-2026-08-29",
    };

    const r1 = post(headersWithKey);
    const res1 = await POST(r1);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.jobId).toBe("job-idempotency-key-test");
    expect(json1.idempotent).toBe(false);

    const r2 = post(headersWithKey);
    const res2 = await POST(r2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.jobId).toBe("job-idempotency-key-test");
    expect(json2.idempotent).toBe(true);

    expect(backgroundQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});
