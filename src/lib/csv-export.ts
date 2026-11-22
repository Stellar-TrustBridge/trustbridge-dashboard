import "server-only";

import { buildCsv, buildCsvFilename } from "@/lib/csv";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import type { ContributorRow } from "@/types";

const CSV_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cachedCsv: { data: string; timestamp: number } | null = null;

/**
 * UTF-8 BOM policy for Excel compatibility.
 *
 * Excel (Windows, and macOS in some locales) mis-decodes UTF-8 CSV files that
 * lack a byte-order mark, producing mojibake in payout spreadsheets. We default
 * to emitting the BOM so Excel opens exports correctly, while allowing callers
 * to opt out (e.g. for tooling that treats the BOM as data).
 *
 * The BOM is prepended AFTER serialization so it never participates in cell
 * escaping or the CSV injection guards applied by `buildCsv`.
 */
export const UTF8_BOM = "\uFEFF";

export interface CsvExportOptions {
  /** Prepend a UTF-8 BOM for Excel compatibility. Defaults to `true`. */
  bom?: boolean;
}

function applyBom(csv: string, options?: CsvExportOptions): string {
  const includeBom = options?.bom ?? true;
  if (!includeBom) {
    return csv;
  }
  // Avoid double-prefixing if the serialized output already starts with a BOM.
  return csv.startsWith(UTF8_BOM) ? csv : `${UTF8_BOM}${csv}`;
}

export function buildContributorsCsv(
  contributors: ContributorRow[],
  options?: CsvExportOptions
): string {
  const headers = [
    "id",
    "githubUsername",
    "stellarAddress",
    "funded",
    "trustlineReady",
    "trustlineAuthorized",
    "verified",
    "xlmBalance",
    "spendableXlmBalance",
    "readiness",
    "lastCheckedAt",
    "horizonDebugSummary",
    "horizonNextAction",
    "freighterProofChallenge",
  ];

  const rows = contributors.map((contributor) => {
    const horizonDebug =
      contributor.horizonDebug ??
      buildHorizonDebugInfo({
        funded: contributor.funded,
        trustlineReady: contributor.trustlineReady,
        trustlineAuthorized: contributor.trustlineAuthorized,
        readiness: contributor.readiness,
        xlmBalance: contributor.xlmBalance,
        spendableXlmBalance: contributor.spendableXlmBalance,
        lastCheckedAt: contributor.lastCheckedAt,
      });
    const walletProof =
      contributor.walletProof ??
      buildWalletProofInfo(
        contributor.stellarAddress,
        contributor.githubUsername
      );

    return [
      contributor.id,
      contributor.githubUsername,
      contributor.stellarAddress,
      contributor.funded ? "yes" : "no",
      contributor.trustlineReady ? "yes" : "no",
      contributor.trustlineAuthorized ? "yes" : "no",
      contributor.verified ? "yes" : "no",
      contributor.xlmBalance,
      contributor.spendableXlmBalance,
      contributor.readiness,
      contributor.lastCheckedAt || "",
      horizonDebug.summary,
      horizonDebug.nextAction,
      walletProof.challenge,
    ];
  });

  return applyBom(buildCsv(headers, rows), options);
}

export function getContributorsCsvFilename(date = new Date()): string {
  return buildCsvFilename("contributors", date);
}

export function getCachedCsv(
  contributors: ContributorRow[],
  options?: CsvExportOptions
): string {
  const now = Date.now();

  if (
    cachedCsv &&
    now - cachedCsv.timestamp < CSV_CACHE_TTL
  ) {
    return cachedCsv.data;
  }

  const csv = buildContributorsCsv(contributors, options);
  cachedCsv = { data: csv, timestamp: now };
  return csv;
}

export function invalidateCsvCache(): void {
  cachedCsv = null;
}
