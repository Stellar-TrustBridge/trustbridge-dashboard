/**
 * Issue #151 — contributor-facing readiness copy.
 *
 * The badge/guidance strings are keyed by `ReadinessStatus` and by reason
 * code, so they get a regression test: completeness, plain-language rules, and
 * — the part that actually bites — agreement between what a badge promises and
 * what `computeNextAction()` will tell the same contributor to do.
 *
 * The shared `READINESS_ACTION_PARITY_TABLE` fixture in `readiness.ts` is the
 * single source of truth for which Action reason codes map to which readiness
 * status. Tests here verify every row of that table, so a future change to
 * `computeReadiness`, `computeNextAction`, or `READINESS_CONFIG` that breaks
 * the correspondence is caught immediately.
 */

import { describe, expect, it } from "vitest";

import {
  computeNextAction,
  WIZARD_ACTION_COPY,
  type WizardAction,
} from "@/lib/action-lookup";
import {
  buildCheckResult,
  computeReadiness,
  describeReadiness,
  describeReadinessWithNextStep,
  getReadinessConfig,
  getReadinessNextStep,
  READINESS_ACTION_PARITY_TABLE,
  READINESS_CONFIG,
} from "@/lib/readiness";
import {
  emptyCheckResult,
  describeBreakerError,
} from "@/lib/check-api";
import { CircuitBreakerOpenError } from "@/lib/circuit-breaker";
import type { HorizonCheckResult, ReadinessStatus } from "@/types";

const STATUSES: ReadinessStatus[] = ["ready", "low_reserve", "not_ready"];

const ACTIONS: WizardAction[] = [
  "fund_account",
  "add_trustline",
  "await_trustline_authorization",
  "increase_reserve",
  "none",
];

/**
 * Terms that mean nothing to a contributor arriving from a GitHub issue. They
 * are allowed in copy only when the same string also explains them, which is
 * why each entry carries the phrase that has to sit alongside it.
 */
const JARGON_NEEDING_GLOSS: Array<{ term: RegExp; gloss: RegExp }> = [
  { term: /trustline/i, gloss: /turn on|turned on|opt in|opts in/i },
  { term: /\breserve\b/i, gloss: /deposit|locked|small amount/i },
  { term: /\bhorizon\b/i, gloss: /never allowed/i },
];

/** Raw status codes and API field names must never reach contributor copy. */
const LEAKED_INTERNALS = [
  "low_reserve",
  "not_ready",
  "trustline_authorized",
  "spendable_xlm_balance",
  "reason_code",
];

describe("READINESS_CONFIG — keyed contributor copy", () => {
  it("covers every readiness status", () => {
    expect(Object.keys(READINESS_CONFIG).sort()).toEqual([...STATUSES].sort());
  });

  it.each(STATUSES)("%s has a label, an explanation, and a next step", (status) => {
    const config = getReadinessConfig(status);

    expect(config.label.trim().length).toBeGreaterThan(0);
    expect(config.description.trim().length).toBeGreaterThan(0);
    expect(config.nextStep.trim().length).toBeGreaterThan(0);
    // Full sentences — these are read aloud by screen readers and pasted into
    // support threads, not squeezed into a chip.
    expect(config.description).toMatch(/\.$/);
    expect(config.nextStep).toMatch(/\.$/);
  });

  it.each(STATUSES)("%s copy leaks no internal identifiers", (status) => {
    const config = getReadinessConfig(status);
    const copy = `${config.label} ${config.description} ${config.nextStep}`;

    for (const internal of LEAKED_INTERNALS) {
      expect(copy).not.toContain(internal);
    }
  });

  it.each(STATUSES)("%s explains any Stellar jargon it uses", (status) => {
    const config = getReadinessConfig(status);
    const copy = `${config.description} ${config.nextStep}`;

    for (const { term, gloss } of JARGON_NEEDING_GLOSS) {
      if (term.test(copy)) {
        expect(copy).toMatch(gloss);
      }
    }
  });

  it("keeps badge labels short enough for a table cell", () => {
    for (const status of STATUSES) {
      expect(getReadinessConfig(status).label.length).toBeLessThanOrEqual(20);
    }
  });

  it("gives each status a distinct label", () => {
    const labels = STATUSES.map((status) => getReadinessConfig(status).label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("readiness copy helpers", () => {
  it("describeReadiness returns the plain-language explanation", () => {
    expect(describeReadiness("ready")).toBe(READINESS_CONFIG.ready.description);
  });

  it("getReadinessNextStep returns the what-to-do-next line", () => {
    expect(getReadinessNextStep("low_reserve")).toBe(
      READINESS_CONFIG.low_reserve.nextStep
    );
  });

  it("describeReadinessWithNextStep joins explanation and next step", () => {
    expect(describeReadinessWithNextStep("not_ready")).toBe(
      `${READINESS_CONFIG.not_ready.description} ${READINESS_CONFIG.not_ready.nextStep}`
    );
  });
});

describe("WIZARD_ACTION_COPY — keyed reason-code copy", () => {
  it("covers every reason code", () => {
    expect(Object.keys(WIZARD_ACTION_COPY).sort()).toEqual([...ACTIONS].sort());
  });

  it.each(ACTIONS)("%s copy tells the contributor what to do", (action) => {
    const copy = WIZARD_ACTION_COPY[action];
    expect(copy.trim().length).toBeGreaterThan(0);
    expect(copy).toMatch(/\.$/);
  });

  it.each(ACTIONS)("%s copy leaks no internal identifiers", (action) => {
    for (const internal of LEAKED_INTERNALS) {
      expect(WIZARD_ACTION_COPY[action]).not.toContain(internal);
    }
  });

  it.each(ACTIONS)("%s copy explains any Stellar jargon it uses", (action) => {
    const copy = WIZARD_ACTION_COPY[action];
    for (const { term, gloss } of JARGON_NEEDING_GLOSS) {
      if (term.test(copy)) {
        expect(copy).toMatch(gloss);
      }
    }
  });
});

// ── Accuracy: badge copy vs. the reason code the same account produces ──────

function check(overrides: Partial<HorizonCheckResult>): HorizonCheckResult {
  return {
    funded: false,
    trustline: false,
    trustline_authorized: false,
    verified: false,
    xlm_balance: "0",
    spendable_xlm_balance: "0",
    usdc_balance: "0",
    errors: [],
    readiness: "not_ready",
    ...overrides,
  };
}

describe("badge copy stays accurate against Action reason codes", () => {
  it("every reason code is claimed by exactly one readiness status", () => {
    const claimed = STATUSES.flatMap(
      (status) => getReadinessConfig(status).reasonCodes
    );
    expect(claimed.sort()).toEqual([...ACTIONS].sort());
  });

  const cases: Array<{
    name: string;
    result: HorizonCheckResult;
    expectedAction: WizardAction;
  }> = [
    {
      name: "unfunded account",
      result: check({ readiness: "not_ready" }),
      expectedAction: "fund_account",
    },
    {
      name: "funded account with no trustline",
      result: check({ funded: true, readiness: "not_ready" }),
      expectedAction: "add_trustline",
    },
    {
      name: "trustline awaiting issuer authorization",
      result: check({ funded: true, trustline: true, readiness: "not_ready" }),
      expectedAction: "await_trustline_authorization",
    },
    {
      name: "low reserve",
      result: check({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        readiness: "low_reserve",
      }),
      expectedAction: "increase_reserve",
    },
    {
      name: "ready",
      result: check({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        verified: true,
        readiness: "ready",
      }),
      expectedAction: "none",
    },
  ];

  it.each(cases)(
    "$name: the badge's status lists the reason code the wizard actually returns",
    ({ result, expectedAction }) => {
      const action = computeNextAction(result);
      expect(action).toBe(expectedAction);
      expect(getReadinessConfig(result.readiness).reasonCodes).toContain(action);
    }
  );

  it("only the ready badge says there is nothing to do", () => {
    expect(getReadinessConfig("ready").nextStep).toMatch(/nothing to do/i);
    expect(getReadinessConfig("low_reserve").nextStep).not.toMatch(
      /nothing to do/i
    );
    expect(getReadinessConfig("not_ready").nextStep).not.toMatch(
      /nothing to do/i
    );
  });

  it("the low-balance badge and the increase_reserve reason code both ask for XLM", () => {
    expect(getReadinessConfig("low_reserve").nextStep).toMatch(/XLM/);
    expect(WIZARD_ACTION_COPY.increase_reserve).toMatch(/XLM/);
  });

  it("the not-ready badge does not promise a payout can arrive", () => {
    expect(getReadinessConfig("not_ready").description).toMatch(
      /cannot receive/i
    );
  });
});

// ── Shared parity table: readiness.ts ↔ Action reason codes ─────────────────

describe("READINESS_ACTION_PARITY_TABLE — shared fixture integrity", () => {
  it("contains exactly one row per readiness status", () => {
    const statuses = READINESS_ACTION_PARITY_TABLE.map((r) => r.readiness);
    expect([...new Set(statuses)].sort()).toEqual([...STATUSES].sort());
  });

  it("contains exactly one row per WizardAction reason code", () => {
    const actions = READINESS_ACTION_PARITY_TABLE.map((r) => r.action);
    expect([...new Set(actions)].sort()).toEqual([...ACTIONS].sort());
  });

  it.each(READINESS_ACTION_PARITY_TABLE)(
    "$description: computeNextAction returns $action for the declared fields",
    ({ fields, action }) => {
      const result: HorizonCheckResult = {
        ...fields,
        verified: fields.funded && fields.trustline && fields.trustline_authorized,
        usdc_balance: "0",
        errors: [],
        // Derive readiness via computeReadiness to avoid hard-coding it in the fixture.
        readiness: computeReadiness(fields.funded, fields.trustline, fields.xlm_balance, {
          authorized: fields.trustline_authorized,
          spendableBalance: fields.spendable_xlm_balance,
        }),
      };
      expect(computeNextAction(result)).toBe(action);
    }
  );

  it.each(READINESS_ACTION_PARITY_TABLE)(
    "$description: computeReadiness returns $readiness for the declared fields",
    ({ fields, readiness }) => {
      const actual = computeReadiness(fields.funded, fields.trustline, fields.xlm_balance, {
        authorized: fields.trustline_authorized,
        spendableBalance: fields.spendable_xlm_balance,
      });
      expect(actual).toBe(readiness);
    }
  );

  it.each(READINESS_ACTION_PARITY_TABLE)(
    "$description: READINESS_CONFIG[$readiness].reasonCodes contains $action",
    ({ readiness, action }) => {
      expect(getReadinessConfig(readiness).reasonCodes).toContain(action);
    }
  );
});

// ── check-api.ts parity — emptyCheckResult and breaker errors ────────────────

describe("check-api.ts parity — emptyCheckResult shape", () => {
  it("emptyCheckResult defaults to not_ready with no errors", () => {
    const r = emptyCheckResult();
    expect(r.readiness).toBe("not_ready");
    expect(r.errors).toEqual([]);
    expect(r.funded).toBe(false);
    expect(r.trustline).toBe(false);
    expect(r.trustline_authorized).toBe(false);
    expect(r.verified).toBe(false);
  });

  it("emptyCheckResult accepts an explicit readiness override", () => {
    const r = emptyCheckResult("low_reserve", ["balance too low"]);
    expect(r.readiness).toBe("low_reserve");
    expect(r.errors).toEqual(["balance too low"]);
  });

  it("emptyCheckResult never leaks internal field names as readiness values", () => {
    // ReadinessStatus union is exhaustive; check the actual value is in it.
    const valid: ReadinessStatus[] = ["ready", "low_reserve", "not_ready"];
    expect(valid).toContain(emptyCheckResult().readiness);
  });

  it("emptyCheckResult balances are always non-negative string numbers", () => {
    const r = emptyCheckResult();
    expect(Number(r.xlm_balance)).toBeGreaterThanOrEqual(0);
    expect(Number(r.spendable_xlm_balance)).toBeGreaterThanOrEqual(0);
    expect(Number(r.usdc_balance)).toBeGreaterThanOrEqual(0);
  });
});

describe("check-api.ts parity — describeBreakerError messages", () => {
  it("circuit-open error produces a degraded flag and actionable message", () => {
    const result = describeBreakerError(new CircuitBreakerOpenError());
    expect(result.degraded).toBe(true);
    expect(result.message).toMatch(/temporarily unavailable/i);
    expect(result.message).not.toContain("circuit");   // no internal jargon
    expect(result.message).not.toContain("breaker");
  });

  it("generic Error produces a non-degraded result with the original message", () => {
    const result = describeBreakerError(new Error("RPC rate limit exceeded"));
    expect(result.degraded).toBe(false);
    expect(result.message).toBe("RPC rate limit exceeded");
  });

  it("non-Error value is stringified without throwing", () => {
    const result = describeBreakerError("string error");
    expect(result.degraded).toBe(false);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("empty-message Error falls back to a non-empty default", () => {
    const result = describeBreakerError(new Error(""));
    expect(result.degraded).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

// ── Full pipeline parity: Horizon fields → readiness → badge → wizard ────────

describe("full pipeline parity — Horizon result flows through every layer consistently", () => {
  /**
   * Build a full HorizonCheckResult from the parity table's minimal fields,
   * using `buildCheckResult` (the same function the /api/check route uses)
   * so the pipeline starts at the same point the API does.
   */
  function buildFromParityRow(row: (typeof READINESS_ACTION_PARITY_TABLE)[number]): HorizonCheckResult {
    return buildCheckResult(
      row.fields.funded,
      row.fields.trustline,
      row.fields.xlm_balance,
      [],
      row.fields.trustline_authorized,
      row.fields.spendable_xlm_balance
    );
  }

  it.each(READINESS_ACTION_PARITY_TABLE)(
    "$description: buildCheckResult produces $readiness via full pipeline",
    (row) => {
      const result = buildFromParityRow(row);
      // 1. readiness field is correct
      expect(result.readiness).toBe(row.readiness);
      // 2. wizard returns the declared reason code
      expect(computeNextAction(result)).toBe(row.action);
      // 3. badge config lists that reason code
      expect(getReadinessConfig(result.readiness).reasonCodes).toContain(row.action);
      // 4. badge variant is set (no undefined)
      expect(["ready", "warning", "danger"]).toContain(getReadinessConfig(result.readiness).variant);
    }
  );

  it("every pipeline output has non-empty copy at each layer", () => {
    for (const row of READINESS_ACTION_PARITY_TABLE) {
      const result = buildFromParityRow(row);
      const config = getReadinessConfig(result.readiness);
      const copy = WIZARD_ACTION_COPY[row.action];

      expect(config.label.trim()).toBeTruthy();
      expect(config.description.trim()).toBeTruthy();
      expect(config.nextStep.trim()).toBeTruthy();
      expect(copy.trim()).toBeTruthy();
    }
  });

  it("no pipeline output leaks an internal reason code or field name as user-visible copy", () => {
    const INTERNALS = [
      "low_reserve", "not_ready", "trustline_authorized",
      "spendable_xlm_balance", "reason_code", "fund_account",
      "add_trustline", "await_trustline_authorization", "increase_reserve",
    ];

    for (const row of READINESS_ACTION_PARITY_TABLE) {
      const result = buildFromParityRow(row);
      const config = getReadinessConfig(result.readiness);
      const userCopy = `${config.label} ${config.description} ${config.nextStep}`;
      const wizardCopy = WIZARD_ACTION_COPY[row.action];

      for (const internal of INTERNALS) {
        expect(userCopy).not.toContain(internal);
        expect(wizardCopy).not.toContain(internal);
      }
    }
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("readiness edge cases — malformed and boundary inputs", () => {
  it("non-numeric xlm_balance string is treated as 0", () => {
    // A malformed Horizon response with a garbage balance must not throw
    // and must land in a stable status.
    expect(computeReadiness(true, true, "not-a-number")).toBe("low_reserve");
    expect(computeReadiness(true, true, "")).toBe("low_reserve");
    expect(computeReadiness(true, true, "NaN")).toBe("low_reserve");
  });

  it("exactly-at-minimum spendable balance is ready (boundary inclusive)", () => {
    // MIN_XLM_BALANCE default is 1.5; test the exact boundary.
    const minBalance = String(1.5);
    expect(
      computeReadiness(true, true, "10", { authorized: true, spendableBalance: minBalance })
    ).toBe("ready");
  });

  it("one satoshi below minimum is low_reserve (boundary exclusive)", () => {
    expect(
      computeReadiness(true, true, "10", {
        authorized: true,
        spendableBalance: String(1.5 - 0.0000001),
      })
    ).toBe("low_reserve");
  });

  it("funded + trustline + zero spendable balance is low_reserve, not not_ready", () => {
    expect(
      computeReadiness(true, true, "2", { authorized: true, spendableBalance: "0" })
    ).toBe("low_reserve");
  });

  it("funded with unauthorized trustline is not_ready regardless of balance", () => {
    expect(
      computeReadiness(true, true, "100", { authorized: false, spendableBalance: "50" })
    ).toBe("not_ready");
  });

  it("empty errors array in buildCheckResult does not break readiness", () => {
    const r = buildCheckResult(true, true, "10", [], true, "5");
    expect(r.errors).toEqual([]);
    expect(r.readiness).toBe("ready");
  });

  it("non-empty errors array in buildCheckResult is preserved verbatim", () => {
    const r = buildCheckResult(false, false, "0", ["Account not found"], false);
    expect(r.errors).toEqual(["Account not found"]);
    expect(r.readiness).toBe("not_ready");
  });
});
