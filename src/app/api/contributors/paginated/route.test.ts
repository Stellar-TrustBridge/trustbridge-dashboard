import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { requireMaintainerSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getContributorsPaginated } from "@/lib/registrations";
import { GET } from "@/app/api/contributors/paginated/route";

function get(url: string) {
  return new NextRequest(url, {
    method: "GET",
    headers: { host: "localhost:3000" },
  });
}

describe("GET /api/contributors/paginated", () => {
  beforeEach(() => {
    vi.mocked(requireMaintainerSession).mockResolvedValue({
      user: { id: "u-1", isMaintainer: true },
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 without a maintainer session", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);

    const res = await GET(
      get("http://localhost:3000/api/contributors/paginated")
    );

    expect(res.status).toBe(403);
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("delegates cursor pagination to getContributorsPaginated with defaults", async () => {
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(prisma.registration.count).mockResolvedValue(0);

    const res = await GET(
      get("http://localhost:3000/api/contributors/paginated")
    );

    expect(res.status).toBe(200);
    expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25);
    const json = await res.json();
    expect(json.registryMode).toBe("live");
  });

  it("passes the requested limit and cursor straight through", async () => {
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: "opaque-cursor",
      hasMore: true,
    });
    vi.mocked(prisma.registration.count).mockResolvedValue(42);

    const validCursor = Buffer.from("reg-1", "utf-8").toString("base64");
    const res = await GET(
      get(
        `http://localhost:3000/api/contributors/paginated?limit=10&cursor=${encodeURIComponent(validCursor)}`
      )
    );

    expect(getContributorsPaginated).toHaveBeenCalledWith(validCursor, 10);
    const json = await res.json();
    expect(json.total).toBe(42);
    expect(json.hasMore).toBe(true);
    expect(json.nextCursor).toBe("opaque-cursor");
  });

  it("ignores an out-of-range limit and falls back to the default", async () => {
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(prisma.registration.count).mockResolvedValue(0);

    await GET(
      get("http://localhost:3000/api/contributors/paginated?limit=500")
    );

    expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25);
  });

  it("returns 400 INVALID_CURSOR for a malformed cursor (no silent page-0 restart)", async () => {
    const res = await GET(
      get("http://localhost:3000/api/contributors/paginated?cursor=!!!bad!!!")
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CURSOR");
    expect(body.error).toBe("Invalid cursor");
    expect(body.message).toBeTruthy();
    expect(body.remediation).toBeTruthy();
    expect(getContributorsPaginated).not.toHaveBeenCalled();
    expect(prisma.registration.count).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_CURSOR for a non-base64 cursor", async () => {
    const res = await GET(
      get(
        "http://localhost:3000/api/contributors/paginated?cursor=not%20base64%21"
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_CURSOR");
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("still accepts a valid base64 cursor", async () => {
    const valid = Buffer.from("reg-9", "utf-8").toString("base64");
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(prisma.registration.count).mockResolvedValue(0);

    const res = await GET(
      get(
        `http://localhost:3000/api/contributors/paginated?cursor=${encodeURIComponent(valid)}`
      )
    );

    expect(res.status).toBe(200);
    expect(getContributorsPaginated).toHaveBeenCalledWith(valid, 25);
  });

  it("treats an empty cursor as the first page", async () => {
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(prisma.registration.count).mockResolvedValue(0);

    const res = await GET(
      get("http://localhost:3000/api/contributors/paginated?cursor=")
    );

    expect(res.status).toBe(200);
    expect(getContributorsPaginated).toHaveBeenCalledWith("", 25);
  });
});
