/**
 * Tests for role-hierarchy helpers in src/lib/auth.ts
 *
 * Covers:
 *   Happy path  — maintainer with sufficient appRole passes requireMaintainerWithRole
 *   Failure #1  — contributor (non-maintainer) is rejected with 403 "forbidden"
 *   Failure #2  — maintainer with insufficient role is rejected with 403 "role_required"
 *   Edge cases  — unauthenticated, missing appRole, unknown appRole
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  requireMaintainerWithRole,
  getSessionUser,
} from "@/lib/auth";
import { canBan, canInvite, canReadDashboard } from "@/lib/maintainers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(user: Record<string, unknown> | null): NextRequest {
  const headers: Record<string, string> = {
    host: "localhost:3000",
  };
  if (user !== null) {
    headers["x-session-user"] = JSON.stringify(user);
  }
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

function adminUser(appRole?: string) {
  return {
    id: "u-1",
    login: "alice",
    role: "maintainer",
    orgs: ["org-a"],
    appRole,
  };
}

// ---------------------------------------------------------------------------
// getSessionUser — appRole parsing
// ---------------------------------------------------------------------------

describe("getSessionUser — appRole parsing", () => {
  it("parses a known appRole from the session header", () => {
    const req = makeRequest({ id: "u-1", login: "alice", role: "maintainer", orgs: [], appRole: "operator" });
    const user = getSessionUser(req);
    expect(user?.appRole).toBe("operator");
  });

  it("parses all three known appRoles", () => {
    for (const appRole of ["admin", "operator", "viewer"] as const) {
      const req = makeRequest({ id: "u-1", login: "alice", role: "maintainer", orgs: [], appRole });
      expect(getSessionUser(req)?.appRole).toBe(appRole);
    }
  });

  it("returns undefined appRole for unknown values", () => {
    const req = makeRequest({ id: "u-1", login: "alice", role: "maintainer", orgs: [], appRole: "superadmin" });
    expect(getSessionUser(req)?.appRole).toBeUndefined();
  });

  it("returns undefined appRole when the field is absent", () => {
    const req = makeRequest({ id: "u-1", login: "alice", role: "maintainer", orgs: [] });
    expect(getSessionUser(req)?.appRole).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requireMaintainerWithRole — happy paths
// ---------------------------------------------------------------------------

describe("requireMaintainerWithRole — happy paths", () => {
  it("allows an admin to ban", () => {
    const req = makeRequest(adminUser("admin"));
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(true);
  });

  it("allows an operator to ban", () => {
    const req = makeRequest(adminUser("operator"));
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(true);
  });

  it("allows an admin to invite", () => {
    const req = makeRequest(adminUser("admin"));
    const result = requireMaintainerWithRole(req, canInvite);
    expect(result.ok).toBe(true);
  });

  it("allows any maintainer role to read the dashboard", () => {
    for (const appRole of ["admin", "operator", "viewer"] as const) {
      const req = makeRequest(adminUser(appRole));
      const result = requireMaintainerWithRole(req, canReadDashboard);
      expect(result.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure path #1 — non-maintainer is rejected
// ---------------------------------------------------------------------------

describe("requireMaintainerWithRole — non-maintainer rejected", () => {
  it("rejects a contributor with 403 forbidden", () => {
    const req = makeRequest({ id: "u-2", login: "bob", role: "contributor", orgs: [], appRole: "admin" });
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden");
    expect(result.status).toBe(403);
  });

  it("rejects unauthenticated request with 401", () => {
    const req = makeRequest(null);
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Failure path #2 — insufficient role is rejected
// ---------------------------------------------------------------------------

describe("requireMaintainerWithRole — insufficient role rejected", () => {
  it("rejects a viewer trying to ban (operator required)", () => {
    const req = makeRequest(adminUser("viewer"));
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("role_required");
    expect(result.status).toBe(403);
  });

  it("rejects an operator trying to invite (admin required)", () => {
    const req = makeRequest(adminUser("operator"));
    const result = requireMaintainerWithRole(req, canInvite);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("role_required");
    expect(result.status).toBe(403);
  });

  it("rejects a viewer trying to invite (admin required)", () => {
    const req = makeRequest(adminUser("viewer"));
    const result = requireMaintainerWithRole(req, canInvite);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("role_required");
    expect(result.status).toBe(403);
  });

  it("rejects a maintainer with no appRole for ban (operator required)", () => {
    // A maintainer without an appRole has no fine-grained role; falls below operator.
    const req = makeRequest(adminUser(undefined));
    const result = requireMaintainerWithRole(req, canBan);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("role_required");
    expect(result.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Cross-action: operator can ban but cannot invite
// ---------------------------------------------------------------------------

describe("ban vs invite power separation via requireMaintainerWithRole", () => {
  it("operator: ban allowed, invite denied", () => {
    const req = makeRequest(adminUser("operator"));
    expect(requireMaintainerWithRole(req, canBan).ok).toBe(true);
    // Need a fresh request object (NextRequest body is consumed once)
    const req2 = makeRequest(adminUser("operator"));
    expect(requireMaintainerWithRole(req2, canInvite).ok).toBe(false);
  });

  it("admin: both ban and invite allowed", () => {
    const req = makeRequest(adminUser("admin"));
    expect(requireMaintainerWithRole(req, canBan).ok).toBe(true);
    const req2 = makeRequest(adminUser("admin"));
    expect(requireMaintainerWithRole(req2, canInvite).ok).toBe(true);
  });
});
