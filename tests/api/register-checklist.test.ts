import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET, PATCH } from "@/app/api/register/checklist/route";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function patch(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/register/checklist", {
    method: "PATCH",
    headers: headers ?? sameOriginHeaders,
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/register/checklist", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty checklist when registration has no checklist data", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: null,
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checklistCompleted).toEqual({});
  });

  it("returns persisted checklist state", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: { stellarAccountCreated: true, addressRegistered: true },
    } as any);

    const res = await GET();
    const json = await res.json();
    expect(json.checklistCompleted.stellarAccountCreated).toBe(true);
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });
});

describe("PATCH /api/register/checklist", () => {
  it("returns 403 for cross-origin requests", async () => {
    const r = patch(
      { addressRegistered: true },
      { origin: "https://evil.com", host: "localhost:3000", "content-type": "application/json" }
    );
    const res = await PATCH(r);
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(401);
  });

  it("returns 404 when user has no registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);

    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(404);
  });

  it("merges incoming keys without wiping existing completed steps", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: { stellarAccountCreated: true },
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(200);

    const json = await res.json();
    // Previously completed step must be preserved.
    expect(json.checklistCompleted.stellarAccountCreated).toBe(true);
    // New step must be applied.
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });

  it("strips unknown keys from the payload", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: {},
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ unknownKey: true, addressRegistered: true });
    const res = await PATCH(r);
    const json = await res.json();

    expect("unknownKey" in json.checklistCompleted).toBe(false);
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });

  it("null checklistCompleted from server normalises to {} before merge", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: null,
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ usdcTrustlineAdded: true });
    const res = await PATCH(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checklistCompleted.usdcTrustlineAdded).toBe(true);
  });
});
