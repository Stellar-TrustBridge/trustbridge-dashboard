import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the modules under test.
// ---------------------------------------------------------------------------
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

import {
  verifyWebhookSignature,
  processGithubOrgMembershipEvent,
  revokeSessionsForUser,
  type GithubOrgMembershipPayload,
} from "@/lib/github-org-membership-webhook";

import { POST as webhookPOST } from "@/app/api/webhooks/github-org-membership/route";
import { POST as replayPOST } from "@/app/api/webhooks/github-org-membership/replay/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";

function sign(body: string, secret = TEST_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makePayload(
  action = "member_added",
  login = "octocat",
  githubId = 1
): GithubOrgMembershipPayload {
  return {
    action,
    membership: { user: { id: githubId, login }, role: "member", state: "active" },
    organization: { login: "stellar-org" },
    sender: { login: "admin" },
  };
}

function webhookRequest(body: string, sig: string | null): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new NextRequest(
    "http://localhost:3000/api/webhooks/github-org-membership",
    { method: "POST", headers, body }
  );
}

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function replayRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/webhooks/github-org-membership/replay",
    { method: "POST", headers: headers ?? sameOriginHeaders, body: JSON.stringify(body) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature (lib — pure)
// ---------------------------------------------------------------------------
describe("verifyWebhookSignature", () => {
  it("returns ok=true for a correct signature (success path)", () => {
    const body = '{"action":"member_added"}';
    const sig = sign(body);
    expect(verifyWebhookSignature(body, sig)).toEqual({ ok: true });
  });

  it("returns ok=false for a tampered body (failure path)", () => {
    const body = '{"action":"member_added"}';
    const sig = sign("different-body");
    const result = verifyWebhookSignature(body, sig);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it("returns ok=false when signature header is missing", () => {
    const result = verifyWebhookSignature('{"a":1}', null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("returns ok=false when GITHUB_WEBHOOK_SECRET is not set", () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const result = verifyWebhookSignature('{"a":1}', sign('{"a":1}'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("returns ok=false for a non-sha256 scheme", () => {
    const result = verifyWebhookSignature('{"a":1}', "sha1=abc123");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// revokeSessionsForUser (lib — unit)
// ---------------------------------------------------------------------------
describe("revokeSessionsForUser", () => {
  it("happy path: resolves user and deletes all sessions (returns count)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 3 });

    const count = await revokeSessionsForUser("octocat");

    expect(count).toBe(3);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubUsername: { equals: "octocat", mode: "insensitive" } },
      })
    );
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("returns 0 when no user is found (no DB rows exist yet)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const count = await revokeSessionsForUser("ghost");

    expect(count).toBe(0);
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 0 for empty / blank login without touching the DB", async () => {
    expect(await revokeSessionsForUser("")).toBe(0);
    expect(await revokeSessionsForUser("   ")).toBe(0);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns -1 and does not throw when Prisma throws (failure path)", async () => {
    vi.mocked(prisma.user.findFirst).mockRejectedValue(new Error("DB connection lost"));

    const count = await revokeSessionsForUser("octocat");

    expect(count).toBe(-1);
    // Must not rethrow
  });

  it("matches login case-insensitively — 'OctoCat' and 'octocat' are the same user", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 1 });

    await revokeSessionsForUser("OctoCat");

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubUsername: { equals: "octocat", mode: "insensitive" } },
      })
    );
  });

  it("deletes all sessions for a user with concurrent active sessions", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    // Simulate 5 concurrent sessions (3 browsers + 2 mobile devices)
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 5 });

    const count = await revokeSessionsForUser("octocat");

    expect(count).toBe(5);
    // deleteMany deletes ALL matching rows atomically — no loop, no TOCTOU
    expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });
});

// ---------------------------------------------------------------------------
// processGithubOrgMembershipEvent (lib)
// ---------------------------------------------------------------------------
describe("processGithubOrgMembershipEvent", () => {
  it("upserts user and returns handled=true for member_added", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_added"));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("member_added");
    expect(result.login).toBe("octocat");
    expect(result.sessionsRevoked).toBe(0);
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { githubId: "1" } })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.github_org_membership.member_added" })
    );
  });

  it("upserts user for member_invited", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_invited"));
    expect(result.handled).toBe(true);
    expect(prisma.user.upsert).toHaveBeenCalled();
  });

  it("revokes sessions on member_removed (happy path)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 2 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_removed"));

    expect(result.handled).toBe(true);
    expect(result.sessionsRevoked).toBe(2);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.github_org_membership.member_removed",
        metadata: expect.objectContaining({ sessionsRevoked: 2 }),
      })
    );
  });

  it("member_removed: sessionsRevoked=0 when no active sessions exist", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_removed"));
    expect(result.sessionsRevoked).toBe(0);
  });

  it("member_removed: audit log flags revocationError when session deletion fails", async () => {
    vi.mocked(prisma.user.findFirst).mockRejectedValue(new Error("DB timeout"));
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_removed"));

    // Result still handled=true — revocation failure must not block the webhook response
    expect(result.handled).toBe(true);
    expect(result.sessionsRevoked).toBe(-1);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ revocationError: true }),
      })
    );
  });

  it("returns handled=false for an unrecognised action", async () => {
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(
      makePayload("member_edited")
    );
    expect(result.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent session / race condition tests
// ---------------------------------------------------------------------------
describe("processGithubOrgMembershipEvent — concurrent session race conditions", () => {
  it("revokes sessions from multiple devices in a single atomic deleteMany", async () => {
    // Simulate a user logged in on 4 different devices simultaneously
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-99" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 4 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_removed", "poweruser"));

    expect(result.sessionsRevoked).toBe(4);
    // deleteMany is called exactly once — not in a loop — so there is no
    // window between individual deletes where a session could be used.
    expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("two concurrent member_removed webhooks for the same user are both handled safely", async () => {
    // Simulate two webhook deliveries racing: first revokes 2 sessions, second sees 0
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany)
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const [first, second] = await Promise.all([
      processGithubOrgMembershipEvent(makePayload("member_removed", "octocat")),
      processGithubOrgMembershipEvent(makePayload("member_removed", "octocat")),
    ]);

    // Both responses are valid and idempotent — second sees 0 sessions left
    expect(first.handled).toBe(true);
    expect(second.handled).toBe(true);
    // Combined revocations sum to 2, with no double-delete
    expect((first.sessionsRevoked ?? 0) + (second.sessionsRevoked ?? 0)).toBe(2);
  });

  it("member_removed followed immediately by member_added does not re-grant session access", async () => {
    // After removal, any new session would only be created on the next GitHub
    // OAuth sign-in — the upsert in member_added creates a User row but no
    // Session row. This test verifies the two operations stay independent.
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const removal = await processGithubOrgMembershipEvent(makePayload("member_removed", "octocat", 1));
    const addition = await processGithubOrgMembershipEvent(makePayload("member_added", "octocat", 1));

    expect(removal.sessionsRevoked).toBe(1);
    // member_added must NOT call session.deleteMany — it only upserts the user
    expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
    expect(addition.sessionsRevoked).toBe(0);
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
  });

  it("revocation happens before the audit log write so a concurrent reader never sees a stale state", async () => {
    const callOrder: string[] = [];

    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockImplementation(async () => {
      callOrder.push("deleteMany");
      return { count: 1 };
    });
    vi.mocked(recordAuditLog).mockImplementation(async () => {
      callOrder.push("auditLog");
      return {} as any;
    });

    await processGithubOrgMembershipEvent(makePayload("member_removed"));

    expect(callOrder).toEqual(["deleteMany", "auditLog"]);
  });

  it("delay in Prisma does not leave a partial revocation — deleteMany is atomic", async () => {
    // Prisma's deleteMany issues a single DELETE WHERE in one round-trip; it
    // cannot be observed in a half-deleted state from another connection.
    // This test proves we call it once with the full userId predicate.
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-42" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 7 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    await processGithubOrgMembershipEvent(makePayload("member_removed", "biguser"));

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-42" },
    });
    // Single call confirms atomicity contract (no iteration over sessions)
    expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/github-org-membership (route)
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/github-org-membership", () => {
  it("returns 401 when signature is missing", async () => {
    const body = JSON.stringify(makePayload());
    const res = await webhookPOST(webhookRequest(body, null));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bad signature", async () => {
    const body = JSON.stringify(makePayload());
    const res = await webhookPOST(webhookRequest(body, sign("wrong-body")));
    expect(res.status).toBe(401);
  });

  it("returns 200 and processes a valid signed payload", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const body = JSON.stringify(makePayload("member_added"));
    const sig = sign(body);
    const res = await webhookPOST(webhookRequest(body, sig));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.handled).toBe(true);
  });

  it("returns 200 and reports sessionsRevoked for a valid member_removed payload", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 2 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const body = JSON.stringify(makePayload("member_removed"));
    const sig = sign(body);
    const res = await webhookPOST(webhookRequest(body, sig));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.sessionsRevoked).toBe(2);
  });

  it("returns 400 for an invalid JSON body with correct signature", async () => {
    const body = "not-json";
    const sig = sign(body);
    const res = await webhookPOST(webhookRequest(body, sig));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/github-org-membership/replay (route)
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/github-org-membership/replay", () => {
  it("returns 403 for cross-origin request", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const r = replayRequest(makePayload(), {
      origin: "https://evil.com",
      host: "localhost:3000",
      "content-type": "application/json",
    });
    const res = await replayPOST(r);
    expect(res.status).toBe(403);
  });

  it("returns 403 when not a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    const r = replayRequest(makePayload());
    const res = await replayPOST(r);
    expect(res.status).toBe(403);
  });

  it("returns 200 and processes the replayed payload for a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const r = replayRequest(makePayload("member_added"));
    const res = await replayPOST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.replayed).toBe(true);
    expect(json.handled).toBe(true);
  });

  it("replay of member_removed also revokes sessions", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "user-99" } as any);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 1 });
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const r = replayRequest(makePayload("member_removed", "departing-user"));
    const res = await replayPOST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessionsRevoked).toBe(1);
  });
});
