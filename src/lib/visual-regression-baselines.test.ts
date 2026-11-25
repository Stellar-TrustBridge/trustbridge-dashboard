import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALL_VISUAL_BASELINES,
  READINESS_CONFIG,
  READINESS_VISUAL_BASELINES,
  validateVisualBaselineCatalog,
  verifyVisualBaselineDocsSync,
  VISUAL_BASELINE_REASON_CODES,
  WAVE_STATUS_BANNER_BASELINES,
  type VisualBaselineEntry,
} from "@/lib/readiness";

const REPO_ROOT = resolve(__dirname, "../..");

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

describe("Visual regression baselines for readiness panel & wave-status banners (Issue #794)", () => {
  it("validates the canonical readiness and wave-status banner baseline catalog (light & dark)", () => {
    const result = validateVisualBaselineCatalog(ALL_VISUAL_BASELINES);
    expect(result).toEqual({ ok: true, issues: [] });

    // Every logical group has both light and dark baselines.
    expect(READINESS_VISUAL_BASELINES.length).toBeGreaterThanOrEqual(4);
    expect(WAVE_STATUS_BANNER_BASELINES.length).toBeGreaterThanOrEqual(6);

    // All ReadinessStatus values in READINESS_CONFIG are covered by readiness panel baselines.
    const coveredStates = new Set(
      READINESS_VISUAL_BASELINES.flatMap((entry) => entry.readinessStates ?? []),
    );
    for (const status of Object.keys(READINESS_CONFIG)) {
      expect(coveredStates.has(status as keyof typeof READINESS_CONFIG)).toBe(true);
    }

    // Repeated invocations are pure and idempotent.
    expect(validateVisualBaselineCatalog(ALL_VISUAL_BASELINES)).toEqual(result);
  });

  it("keeps src/lib/readiness.ts, docs/VISUAL_REGRESSION.md, tests/e2e/visual.spec.ts, dashboard UI, and docs/CONTRIBUTING.md aligned", () => {
    const visualDoc = readRepoFile("docs/VISUAL_REGRESSION.md");
    const visualSpec = readRepoFile("tests/e2e/visual.spec.ts");
    const dashboardPage = readRepoFile("src/app/dashboard/page.tsx");
    const freezeBanner = readRepoFile("src/components/FreezeWindowBanner.tsx");
    const staleBanner = readRepoFile("src/components/StaleDataBanner.tsx");
    const contributingDoc = readRepoFile("docs/CONTRIBUTING.md");

    const syncResult = verifyVisualBaselineDocsSync(
      ALL_VISUAL_BASELINES,
      visualDoc,
      visualSpec,
    );
    expect(syncResult).toEqual({ ok: true, issues: [] });

    // Every target data-testid anchored by a baseline exists in the dashboard or its banner components.
    const uiSources = `${dashboardPage}\n${freezeBanner}\n${staleBanner}`;
    for (const entry of ALL_VISUAL_BASELINES) {
      expect(uiSources).toContain(`data-testid="${entry.testId}"`);
    }

    // CONTRIBUTING.md links to VISUAL_REGRESSION.md and documents the baseline verification workflow.
    expect(contributingDoc).toContain("VISUAL_REGRESSION.md");
    expect(contributingDoc).toContain("visual-regression-baselines.test.ts");
    expect(contributingDoc).toContain("--update-snapshots");

    // Repeated sync checks are idempotent.
    expect(
      verifyVisualBaselineDocsSync(ALL_VISUAL_BASELINES, visualDoc, visualSpec),
    ).toEqual(syncResult);
  });

  it("rejects malformed, oversized, duplicate, or unpaired baseline definitions with stable reason codes", () => {
    const invalidCatalog: VisualBaselineEntry[] = [
      {
        groupId: "unpaired-group",
        surface: "readiness-panel",
        snapshot: "unpaired-only-light.png",
        colorScheme: "light",
        testId: "wave-readiness-panel",
        description: "Missing dark counterpart",
        maxDiffPixelRatio: 0.05,
      },
      {
        groupId: "dup-group",
        surface: "wave-status-banner",
        snapshot: "duplicate-banner-light.png",
        colorScheme: "light",
        testId: "freeze-window-banner",
        description: "First duplicate",
        maxDiffPixelRatio: 0.05,
      },
      {
        groupId: "dup-group",
        surface: "wave-status-banner",
        snapshot: "duplicate-banner-light.png",
        colorScheme: "dark",
        testId: "freeze-window-banner",
        description: "Second duplicate",
        maxDiffPixelRatio: 0.05,
      },
      {
        groupId: "bad-inputs",
        surface: "readiness-panel",
        snapshot: "",
        colorScheme: "light",
        testId: "BAD TEST ID!",
        description: "Malformed snapshot and testId",
        maxDiffPixelRatio: 0.5,
      },
      {
        groupId: "bad-inputs",
        surface: "readiness-panel",
        snapshot: `${"a".repeat(130)}.png`,
        colorScheme: "dark",
        testId: "",
        description: "Oversized snapshot and empty testId",
        maxDiffPixelRatio: Number.NaN,
      },
    ];

    const result = validateVisualBaselineCatalog(invalidCatalog);
    expect(result.ok).toBe(false);

    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has(VISUAL_BASELINE_REASON_CODES.MISSING_COLOR_SCHEME_PAIR)).toBe(true);
    expect(codes.has(VISUAL_BASELINE_REASON_CODES.DUPLICATE_SNAPSHOT_NAME)).toBe(true);
    expect(codes.has(VISUAL_BASELINE_REASON_CODES.INVALID_SNAPSHOT_NAME)).toBe(true);
    expect(codes.has(VISUAL_BASELINE_REASON_CODES.INVALID_TEST_ID)).toBe(true);
    expect(codes.has(VISUAL_BASELINE_REASON_CODES.INVALID_DIFF_THRESHOLD)).toBe(true);
  });

  it("reports actionable drift errors when a baseline is missing from VISUAL_REGRESSION.md or visual.spec.ts", () => {
    const sampleEntry: VisualBaselineEntry = {
      groupId: "drift-check",
      surface: "wave-status-banner",
      snapshot: "wave-status-banner-missing-light.png",
      colorScheme: "light",
      testId: "freeze-window-banner",
      description: "Drifted entry",
      maxDiffPixelRatio: 0.05,
    };

    const result = verifyVisualBaselineDocsSync(
      [sampleEntry],
      "# Visual Regression Testing Guide\n(no matching snapshot)",
      "test('unrelated', async () => {});",
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: VISUAL_BASELINE_REASON_CODES.MISSING_DOC_BASELINE,
        target: "wave-status-banner-missing-light.png",
      }),
      expect.objectContaining({
        code: VISUAL_BASELINE_REASON_CODES.MISSING_SPEC_COVERAGE,
        target: "wave-status-banner-missing-light.png",
      }),
    ]);
  });
});
