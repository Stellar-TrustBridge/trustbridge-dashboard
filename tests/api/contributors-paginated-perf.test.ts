/**
 * Tests for the p95 response-time instrumentation on
 * GET /api/contributors/paginated.
 *
 * Happy path: maintainer request → 200 with x-response-time-ms header.
 * Failure path 1: missing session → 403 (auth guard still works).
 * Failure path 2: invalid cursor → 400 INVALID_CURSOR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/registrations", () => ({
  getContributorsPaginated: vi.fn(),
}));

vi.mock("@/lib/registry-mode", () => ({
  getRegistryMode: vi.fn(() => "live"),
}));

vi.mock("@/lib/cursor-pagination", () => ({
  validatePaginationOptions: vi.fn(() => ({ invalidCursor: false })),
  buildInvalidCursorError: vi.fn(() => ({
    error: "Invalid cursor",
    code: "INVALID_CURSOR",
    message: "The provided cursor is malformed.",
    remediation: "Omit the cursor parameter to restart from the first page.",
  })),
}));

import { GET } from "@/app/api/contributors/paginated/route";
import { requireMaintainerSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getContributorsPaginated } from "@/lib/registrations";
import {
  validatePaginationOptions,
  buildInvalidCursorError,
} from "@/lib/cursor-pagination";

const MAINTAINER = {
  user: { id: "maintainer-1", isMaintainer: true },
};

function request(url = "http://localhost:3000/api/contributors/paginated") {
  return new NextRequest(url, {
    method: "GET",
    headers: { host: "localhost:3000" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMaintainerSession).mockResolvedValue(MAINTAINER as never);
  vi.mocked(getContributorsPaginated).mockResolvedValue({
    contributors: [],
    nextCursor: null,
    hasMore: false,
  } as never);
  vi.mocked(prisma.registration.count).mockResolvedValue(0);
  vi.mocked(validatePaginationOptions).mockReturnValue({ invalidCursor: false });
});

// ---------------------------------------------------------------------------
// Happy path: response includes x-response-time-ms header
// ---------------------------------------------------------------------------
describe("GET /api/contributors/paginated — response time header", () => {
  it("includes x-response-time-ms on a successful response", async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    const header = res.headers.get("x-response-time-ms");
    expect(header).not.toBeNull();
    // Value must be a non-negative integer (ms since start of handler)
    const ms = Number(header);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("returns contributors, total, hasMore, and registryMode in body", async () => {
    vi.mocked(prisma.registration.count).mockResolvedValue(42);
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [{ id: "c1" }],
      nextCursor: null,
      hasMore: false,
    } as never);

    const res = await GET(request());
    const json = await res.json();

    expect(json.total).toBe(42);
    expect(json.contributors).toHaveLength(1);
    expect(json.hasMore).toBe(false);
    expect(json.registryMode).toBe("live");
  });

  it("honours limit and cursor params", async () => {
    await GET(
      request(
        "http://localhost:3000/api/contributors/paginated?limit=50&cursor=abc"
      )
    );

    expect(getContributorsPaginated).toHaveBeenCalledWith("abc", 50);
  });

  it("caps limit at 100 and defaults to 25", async () => {
    await GET(
      request(
        "http://localhost:3000/api/contributors/paginated?limit=999"
      )
    );
    expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25);

    vi.clearAllMocks();
    vi.mocked(requireMaintainerSession).mockResolvedValue(MAINTAINER as never);
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    } as never);
    vi.mocked(prisma.registration.count).mockResolvedValue(0);
    vi.mocked(validatePaginationOptions).mockReturnValue({ invalidCursor: false });

    await GET(request("http://localhost:3000/api/contributors/paginated"));
    expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25);
  });
});

// ---------------------------------------------------------------------------
// Failure path 1: 403 when session is absent
// ---------------------------------------------------------------------------
describe("GET /api/contributors/paginated — auth guard", () => {
  it("returns 403 for a non-maintainer request", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure path 2: 400 for invalid cursor
// ---------------------------------------------------------------------------
describe("GET /api/contributors/paginated — invalid cursor", () => {
  it("returns 400 INVALID_CURSOR for a malformed cursor", async () => {
    vi.mocked(validatePaginationOptions).mockReturnValue({
      invalidCursor: true,
    } as never);

    const res = await GET(
      request(
        "http://localhost:3000/api/contributors/paginated?cursor=%%notbase64"
      )
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_CURSOR");
    expect(buildInvalidCursorError).toHaveBeenCalled();
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });
});
