import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/github-org-membership/route";
import { POST as ReplayPOST } from "@/app/api/webhooks/github-org-membership/replay/route";
import { requireAdmin } from "@/lib/api-auth";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

const WEBHOOK_SECRET = "test-secret-123";

function createSignature(payload: Buffer): string {
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

function createWebhookRequest(
  event: Record<string, unknown>,
  signature: string | null = null
) {
  const payload = Buffer.from(JSON.stringify(event));
  const sig = signature ?? createSignature(payload);

  return new NextRequest("http://localhost:3000/api/webhooks/github-org-membership", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "delivery-id-123",
    },
    body: payload,
  });
}

describe("POST /api/webhooks/github-org-membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue(null);
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.GITHUB_MAINTAINER_ORG = "test-org";
  });

  it("rejects invalid signature", async () => {
    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    const req = createWebhookRequest(event, "sha256=invalid");
    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("rejects request when webhook secret not configured", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    const payload = Buffer.from(JSON.stringify(event));
    const req = new NextRequest(
      "http://localhost:3000/api/webhooks/github-org-membership",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=ignored",
        },
        body: payload,
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("ignores events from different org", async () => {
    const event = {
      action: "added",
      member: { login: "user1", id: 123 },
      organization: { login: "other-org" },
      sender: { login: "admin" },
    };

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("handles member added event", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("accepted");

    // Verify audit log was recorded
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.org_membership_changed",
        targetId: "user-1",
        targetLabel: "testuser",
        metadata: expect.objectContaining({
          membershipAction: "added",
          org: "test-org",
        }),
      })
    );
  });

  it("handles member removed event", async () => {
    const event = {
      action: "deleted",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.org_membership_changed",
        metadata: expect.objectContaining({
          membershipAction: "deleted",
        }),
      })
    );
  });

  it("handles member not found gracefully", async () => {
    const event = {
      action: "added",
      member: { login: "newuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("accepted");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("handles processing errors gracefully", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockRejectedValue(
      new Error("Database error")
    );

    const req = createWebhookRequest(event);
    const res = await POST(req);
    // Should still return 202 to prevent retry storm
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("error");
  });

  it("valid webhook with correct signature", async () => {
    const event = {
      action: "added",
      member: { login: "testuser", id: 123 },
      organization: { login: "test-org" },
      sender: { login: "admin" },
    };

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      githubId: "123",
      githubUsername: "testuser",
      name: "Test User",
      email: "test@example.com",
      image: null,
      accessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createWebhookRequest(event);
    const res = await POST(req);
    expect(res.status).toBe(202);
  });

  it("requires admin access for replay requests", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/webhooks/github-org-membership/replay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "added",
        member: { login: "testuser", id: 123 },
        organization: { login: "test-org" },
        sender: { login: "admin" },
      }),
    });

    const res = await ReplayPOST(req);
    expect(res.status).toBe(403);
  });
});
