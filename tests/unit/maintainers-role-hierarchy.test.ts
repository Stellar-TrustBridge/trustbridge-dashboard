/**
 * Table-driven role hierarchy tests for src/lib/maintainers.ts
 *
 * Verifies the permission predicates that govern which maintainer role may
 * perform each privileged action. Tests are structured as a matrix so adding
 * a new action or role only requires extending one table.
 *
 * Actions under test:
 *   canBan                 — ban / unban a contributor   (operator+)
 *   canInvite              — generate / revoke invites   (admin only)
 *   canRestoreRegistration — restore soft-deleted reg    (operator+)
 *   canChangeNetworkSettings — change Horizon/Soroban   (admin only)
 *   canReadDashboard       — read maintainer dashboard   (viewer+)
 *
 * Also covers:
 *   hasRole                — raw weight comparison
 *   MAINTAINER_ROLE_WEIGHTS — public constant sanity
 */

import { describe, expect, it } from "vitest";

import {
  hasRole,
  canBan,
  canInvite,
  canRestoreRegistration,
  canChangeNetworkSettings,
  canReadDashboard,
  MAINTAINER_ROLE_WEIGHTS,
} from "@/lib/maintainers";
import type { AppRole } from "@/types";

// ---------------------------------------------------------------------------
// Weight table sanity
// ---------------------------------------------------------------------------

describe("MAINTAINER_ROLE_WEIGHTS", () => {
  it("admin > operator > viewer", () => {
    expect(MAINTAINER_ROLE_WEIGHTS.admin).toBeGreaterThan(
      MAINTAINER_ROLE_WEIGHTS.operator
    );
    expect(MAINTAINER_ROLE_WEIGHTS.operator).toBeGreaterThan(
      MAINTAINER_ROLE_WEIGHTS.viewer
    );
    expect(MAINTAINER_ROLE_WEIGHTS.viewer).toBeGreaterThan(0);
  });

  it("covers all three known AppRole values", () => {
    const roles: AppRole[] = ["admin", "operator", "viewer"];
    for (const r of roles) {
      expect(MAINTAINER_ROLE_WEIGHTS[r]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// hasRole — raw comparison
// ---------------------------------------------------------------------------

describe("hasRole", () => {
  const cases: Array<{
    role: AppRole | string | null | undefined;
    minimum: AppRole;
    expected: boolean;
  }> = [
    // admin meets every minimum
    { role: "admin", minimum: "admin", expected: true },
    { role: "admin", minimum: "operator", expected: true },
    { role: "admin", minimum: "viewer", expected: true },
    // operator meets operator and below
    { role: "operator", minimum: "admin", expected: false },
    { role: "operator", minimum: "operator", expected: true },
    { role: "operator", minimum: "viewer", expected: true },
    // viewer only meets viewer
    { role: "viewer", minimum: "admin", expected: false },
    { role: "viewer", minimum: "operator", expected: false },
    { role: "viewer", minimum: "viewer", expected: true },
    // edge cases
    { role: undefined, minimum: "viewer", expected: false },
    { role: null, minimum: "viewer", expected: false },
    { role: "", minimum: "viewer", expected: false },
    { role: "superadmin", minimum: "viewer", expected: false }, // unknown role → weight 0
    { role: "ADMIN", minimum: "viewer", expected: false },      // case-sensitive
  ];

  it.each(cases)(
    "hasRole($role, $minimum) === $expected",
    ({ role, minimum, expected }) => {
      expect(hasRole(role, minimum)).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

type PermissionCase = {
  role: AppRole | string | null | undefined;
  expected: boolean;
};

function matrix(fn: (r: AppRole | string | null | undefined) => boolean) {
  return (cases: PermissionCase[]) => {
    for (const { role, expected } of cases) {
      it(`${fn.name}(${JSON.stringify(role)}) === ${expected}`, () => {
        expect(fn(role)).toBe(expected);
      });
    }
  };
}

// ── canBan (operator+) ──────────────────────────────────────────────────────

describe("canBan — ban/unban requires operator+", () => {
  matrix(canBan)([
    { role: "admin", expected: true },
    { role: "operator", expected: true },
    { role: "viewer", expected: false },
    { role: undefined, expected: false },
    { role: null, expected: false },
    { role: "unknown", expected: false },
  ]);
});

// ── canInvite (admin only) ──────────────────────────────────────────────────

describe("canInvite — invite generation requires admin", () => {
  matrix(canInvite)([
    { role: "admin", expected: true },
    { role: "operator", expected: false },
    { role: "viewer", expected: false },
    { role: undefined, expected: false },
    { role: null, expected: false },
  ]);
});

// ── canRestoreRegistration (operator+) ─────────────────────────────────────

describe("canRestoreRegistration — restore requires operator+", () => {
  matrix(canRestoreRegistration)([
    { role: "admin", expected: true },
    { role: "operator", expected: true },
    { role: "viewer", expected: false },
    { role: undefined, expected: false },
  ]);
});

// ── canChangeNetworkSettings (admin only) ──────────────────────────────────

describe("canChangeNetworkSettings — network config requires admin", () => {
  matrix(canChangeNetworkSettings)([
    { role: "admin", expected: true },
    { role: "operator", expected: false },
    { role: "viewer", expected: false },
    { role: undefined, expected: false },
  ]);
});

// ── canReadDashboard (viewer+) ──────────────────────────────────────────────

describe("canReadDashboard — dashboard read requires viewer+", () => {
  matrix(canReadDashboard)([
    { role: "admin", expected: true },
    { role: "operator", expected: true },
    { role: "viewer", expected: true },
    { role: undefined, expected: false },
    { role: null, expected: false },
  ]);
});

// ---------------------------------------------------------------------------
// Cross-action privilege separation: ban vs invite powers
// This is the core enforcement the issue requires: operators can ban but NOT
// invite; only admins can do both.
// ---------------------------------------------------------------------------

describe("ban vs invite power separation", () => {
  it("operator can ban but cannot invite", () => {
    expect(canBan("operator")).toBe(true);
    expect(canInvite("operator")).toBe(false);
  });

  it("admin can both ban and invite", () => {
    expect(canBan("admin")).toBe(true);
    expect(canInvite("admin")).toBe(true);
  });

  it("viewer can neither ban nor invite", () => {
    expect(canBan("viewer")).toBe(false);
    expect(canInvite("viewer")).toBe(false);
  });

  it("unauthenticated (undefined) can neither ban nor invite", () => {
    expect(canBan(undefined)).toBe(false);
    expect(canInvite(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure paths — malformed / edge inputs never grant permissions
// ---------------------------------------------------------------------------

describe("edge inputs never grant permissions", () => {
  const malformedInputs = [undefined, null, "", "ADMIN", "OPERATOR", "superadmin", 0 as unknown as string];

  it.each(malformedInputs)("canBan(%s) is false", (input) => {
    expect(canBan(input)).toBe(false);
  });

  it.each(malformedInputs)("canInvite(%s) is false", (input) => {
    expect(canInvite(input)).toBe(false);
  });

  it.each(malformedInputs)("canChangeNetworkSettings(%s) is false", (input) => {
    expect(canChangeNetworkSettings(input)).toBe(false);
  });
});
