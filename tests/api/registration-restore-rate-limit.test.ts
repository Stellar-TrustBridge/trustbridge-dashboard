/**
 * Tests for the restore rate-limit and dual-confirmation requirements on
 * POST /api/registrations/[id]/restore.
 *
 * Happy path: maintainer sends { "confirm": true } with valid session → 200.
 * Failure path 1: missing / false confirmation flag → 400 CONFIRM_REQUIRED.
 * Failure path 2: IP exceeds restore burst limit → 429 RESTORE_RATE_LIMITED.
 * Failure path 3: missing body entirely → 400 BODY_REQUIRED.
 * Failure path 4: non-maintainer → 403 (existing guard).
 * Failure path 5: cross-origin request → 403 (existing CSRF guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/cache-tags", () => ({
  invalidateContributorListCaches: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

import { POST } from "@/app/api/registrations/[id]/restore/route";
import { requireMaintainerSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { checkRateLimit } from "@/lib/rate-limit";

const MAINTAINER = {
  user: {
    id: "maintainer-1",
    githubUsername: "octocat",
    isMaintainer: true,
  },
};

const DELETED_REG = {
  id: "reg-1",
  stellarAddress: "GADDRESSEXAMPLE123",
  deletedAt: new Date("2026-11-01T00:00:00Z"),
};

const RESTORED_REG = { ...DELETED_REG, deletedAt: null };

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {
    origin: "http://localhost:3000",
    host: "localhost:3000",
    "content-type": "application/json",
  }
): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/registrations/reg-1/restore",
    {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  );
}

const ALLOWED_RATE = { allowed: true, retryAfter: 0, remaining: 9 };
const BLOCKED_RATE = { allowed: false, retryAfter: 42, remaining: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMaintainerSession).mockResolvedValue(MAINTAINER as never);
  vi.mocked(checkRateLimit).mockReturnValue(ALLOWED_RATE);
  vi.mocked(prisma.registration.findFirst).mockResolvedValue(
    DELETED_REG as never
  );
  vi.mocked(prisma.registration.update).mockResolvedValue(
    RESTORED_REG as never
  );
  vi.mocked(invalidateContributorListCaches).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — happy path", () => {
  it("restores the registration when confirm:true is provided", async () => {
    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.registration.id).toBe("reg-1");
    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { deletedAt: null },
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registration.restore",
        targetId: "reg-1",
        actorId: "maintainer-1",
      })
    );
    expect(invalidateContributorListCaches).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Failure path 1: missing or false confirmation
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — confirm required", () => {
  it("returns 400 CONFIRM_REQUIRED when confirm field is absent", async () => {
    const res = await POST(makeRequest({}), { params: { id: "reg-1" } });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("CONFIRM_REQUIRED");
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIRM_REQUIRED when confirm is false", async () => {
    const res = await POST(makeRequest({ confirm: false }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("CONFIRM_REQUIRED");
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIRM_REQUIRED when confirm is a string", async () => {
    const res = await POST(makeRequest({ confirm: "true" }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("CONFIRM_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Failure path 2: rate limit exceeded
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — rate limit", () => {
  it("returns 429 RESTORE_RATE_LIMITED when the IP has exceeded the burst", async () => {
    vi.mocked(checkRateLimit).mockReturnValue(BLOCKED_RATE);

    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("RESTORE_RATE_LIMITED");
    expect(json.retryAfter).toBe(42);
    expect(res.headers.get("Retry-After")).toBe("42");

    // The rate-limit audit should fire even though the restore itself did not
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registration.restore.rate_limited",
        actorId: "maintainer-1",
      })
    );
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it("includes Retry-After header on rate-limited response", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfter: 30,
      remaining: 0,
    });

    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

// ---------------------------------------------------------------------------
// Failure path 3: missing body
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — malformed body", () => {
  it("returns 400 BODY_REQUIRED when no body is sent", async () => {
    // Create a request with no body (not even null JSON)
    const req = new NextRequest(
      "http://localhost:3000/api/registrations/reg-1/restore",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
        },
        // No body → request.json() will throw
      }
    );

    const res = await POST(req, { params: { id: "reg-1" } });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("BODY_REQUIRED");
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure path 4: non-maintainer
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — auth guard", () => {
  it("returns 403 for a non-maintainer without touching the database", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);

    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure path 5: cross-origin request
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — CSRF guard", () => {
  it("returns 403 for a cross-origin request before any DB work", async () => {
    const res = await POST(
      makeRequest(
        { confirm: true },
        {
          origin: "https://evil.example.com",
          host: "localhost:3000",
          "content-type": "application/json",
        }
      ),
      { params: { id: "reg-1" } }
    );

    expect(res.status).toBe(403);
    expect(prisma.registration.findFirst).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency / edge cases
// ---------------------------------------------------------------------------
describe("POST /api/registrations/[id]/restore — edge cases", () => {
  it("returns 404 when the registration is not soft-deleted", async () => {
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);

    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Deleted registration not found" });
    expect(prisma.registration.update).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("returns 409 when another active registration already uses the address", async () => {
    vi.mocked(prisma.registration.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const res = await POST(makeRequest({ confirm: true }), {
      params: { id: "reg-1" },
    });

    expect(res.status).toBe(409);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});
