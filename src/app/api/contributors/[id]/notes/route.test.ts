import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/maintainers", () => ({
  isMaintainer: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
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
import { isMaintainer } from "@/lib/maintainers";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";

describe("PATCH /api/contributors/[id]/notes", () => {
  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ notes: "test note" }),
    });
    const res = await PATCH(req as any, { params: { id: "reg-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-maintainers", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "user-1" },
    } as any);
    vi.mocked(isMaintainer).mockResolvedValueOnce(false);

    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ notes: "test note" }),
    });
    const res = await PATCH(req as any, { params: { id: "reg-1" } });
    expect(res.status).toBe(403);
  });

  it("sanitizes HTML/XSS and updates notes and tags", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1" },
    } as any);
    vi.mocked(isMaintainer).mockResolvedValueOnce(true);
    vi.mocked(prisma.registration.findUnique).mockResolvedValueOnce({
      id: "reg-1",
      stellarAddress: "GABC...",
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValueOnce({
      id: "reg-1",
      notes: "Clean note",
      tags: ["VIP", "Verified"],
    } as any);

    const req = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({
        notes: "<script>alert('xss')</script>Clean note",
        tags: ["VIP", "<b>Verified</b>"],
      }),
    });
    const res = await PATCH(req as any, { params: { id: "reg-1" } });
    expect(res.status).toBe(200);

    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: {
        notes: "alert('xss')Clean note",
        tags: ["VIP", "Verified"],
      },
    });
  });
});
