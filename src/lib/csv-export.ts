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
 * Threshold (in rows) above which callers should prefer streaming mode.
 * Below this, the buffered `buildContributorsCsv` path is cheaper.
 */
export const CSV_STREAMING_ROW_THRESHOLD = 5_000;

/**
 * Stable reason codes surfaced by streaming exports. Keep in sync with
 * docs/CRON_EXPORT.md and docs/PERFORMANCE_TESTING.md.
 */
export type CsvExportReasonCode =
  | "csv_empty_input"
  | "csv_oversized_input"
  | "csv_malformed_row"
  | "csv_client_cancelled";

export class CsvExportError extends Error {
  readonly code: CsvExportReasonCode;

  constructor(code: CsvExportReasonCode, message: string) {
    super(message);
    this.name = "CsvExportError";
    this.code = code;
  }
}

const CONTRIBUTOR_CSV_HEADERS = [
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

function buildContributorCsvRow(contributor: ContributorRow): string[] {
  if (!contributor || typeof contributor.id !== "string") {
    throw new CsvExportError(
      "csv_malformed_row",
      "Contributor row is missing a valid id"
    );
  }

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
}

export function buildContributorsCsv(
  contributors: ContributorRow[]
): string {
  const rows = contributors.map((contributor) =>
    buildContributorCsvRow(contributor)
  );

  return buildCsv(CONTRIBUTOR_CSV_HEADERS, rows);
}

export function getContributorsCsvFilename(date = new Date()): string {
  return buildCsvFilename("contributors", date);
}

export function getCachedCsv(contributors: ContributorRow[]): string {
  const now = Date.now();

  if (
    cachedCsv &&
    now - cachedCsv.timestamp < CSV_CACHE_TTL
  ) {
    return cachedCsv.data;
  }

  const csv = buildContributorsCsv(contributors);
  cachedCsv = { data: csv, timestamp: now };
  return csv;
}

export function invalidateCsvCache(): void {
  cachedCsv = null;
}

export interface StreamContributorsCsvOptions {
  /** Aborts the stream mid-flight (e.g. client disconnect). */
  signal?: AbortSignal;
  /** Hard cap on rows; exceeding it fails with `csv_oversized_input`. */
  maxRows?: number;
}

/**
 * Streams the contributors CSV incrementally so large Wave orgs never buffer
 * the whole dataset in memory. Emits the header first, then one encoded row
 * per chunk. Honors backpressure via the underlying ReadableStream and stops
 * cleanly on abort without leaving partial privileged state.
 */
export function streamContributorsCsv(
  contributors: ContributorRow[],
  options: StreamContributorsCsvOptions = {}
): ReadableStream<Uint8Array> {
  const { signal, maxRows } = options;
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (contributors.length === 0) {
        controller.error(
          new CsvExportError(
            "csv_empty_input",
            "No contributors available to export"
          )
        );
        return;
      }
      if (maxRows !== undefined && contributors.length > maxRows) {
        controller.error(
          new CsvExportError(
            "csv_oversized_input",
            `Contributor export exceeds maxRows (${maxRows})`
          )
        );
        return;
      }
      controller.enqueue(
        encoder.encode(buildCsv(CONTRIBUTOR_CSV_HEADERS, []))
      );
    },
    pull(controller) {
      if (signal?.aborted) {
        controller.error(
          new CsvExportError(
            "csv_client_cancelled",
            "CSV export cancelled by client"
          )
        );
        return;
      }
      if (index >= contributors.length) {
        controller.close();
        return;
      }
      try {
        const row = buildContributorCsvRow(contributors[index]);
        index += 1;
        controller.enqueue(encoder.encode(buildCsv([], [row])));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // Client disconnected; drop remaining work. No privileged state is held.
      index = contributors.length;
    },
  });
}
