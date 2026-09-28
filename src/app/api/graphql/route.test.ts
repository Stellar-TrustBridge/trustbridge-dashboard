import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn(),
  getContributorsPaginated: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  buildRateLimitHeaders: vi.fn(() => ({})),
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

import { requireMaintainerSession } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  getContributorsPaginated,
  getDashboardStats,
} from "@/lib/registrations";
import { POST } from "@/app/api/graphql/route";

function post(query: string, variables?: Record<string, unknown>) {
  return new NextRequest("http://localhost:3000/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

describe("POST /api/graphql", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true } as never);
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 12,
      readyCount: 8,
      readyPercent: 67,
    });
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  it("serves aggregate stats without maintainer authorization", async () => {
    const response = await POST(post("{ stats { totalContributors readyCount readyPercent } }"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        stats: { totalContributors: 12, readyCount: 8, readyPercent: 67 },
      },
    });
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  it("rate limits requests before executing a query", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false } as never);

    const response = await POST(post("{ stats { totalContributors } }"));

    expect(response.status).toBe(429);
    expect(getDashboardStats).not.toHaveBeenCalled();
  });

  it("returns a GraphQL forbidden error for contributors without a maintainer session", async () => {
    const response = await POST(
      post("{ stats { readyCount } contributors { nodes { githubUsername } } }")
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.data.stats.readyCount).toBe(8);
    expect(result.data.contributors).toBeNull();
    expect(result.errors[0].extensions.code).toBe("FORBIDDEN");
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("uses the bounded cursor query for maintainer contributor reads", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue({
      user: { id: "maintainer-1", isMaintainer: true },
    } as never);

    const response = await POST(
      post(
        "query($first: Int!, $after: String) { contributors(first: $first, after: $after) { nodes { githubUsername stellarAddress readiness } hasMore nextCursor } }",
        { first: 10, after: "cursor-1" }
      )
    );

    expect(response.status).toBe(200);
    expect(getContributorsPaginated).toHaveBeenCalledWith("cursor-1", 10);
  });

  it("rejects writes because the API is read-only", async () => {
    const response = await POST(post("mutation { contributors { hasMore } }"));
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.errors[0].message).toMatch(/read-only/i);
  });

  it("rejects excessive depth and weighted query cost", async () => {
    const deepResponse = await POST(
      post(
        "{ stats { totalContributors { nested { deeper { stillDeeper { value } } } } } }"
      )
    );
    expect((await deepResponse.json()).errors[0].message).toMatch(/depth/i);

    const aliases = Array.from(
      { length: 26 },
      (_, index) => `field${index}: githubUsername`
    ).join(" ");
    const costlyResponse = await POST(
      post(`{ contributors(first: 100) { nodes { ${aliases} } } }`)
    );
    expect((await costlyResponse.json()).errors[0].message).toMatch(/cost/i);
  });

  it("disables schema introspection in production", async () => {
    process.env.NODE_ENV = "production";

    const response = await POST(post("{ __schema { queryType { name } } }"));

    expect(response.status).toBe(400);
    expect((await response.json()).errors[0].message).toMatch(/introspection/i);
  });

  it("does not expose token fields in the contributor schema", async () => {
    const response = await POST(
      post("{ contributors { nodes { githubUsername accessToken } } }")
    );

    expect(response.status).toBe(400);
    expect((await response.json()).errors[0].message).toMatch(/accessToken/i);
  });
});
