import "server-only";

import { createHash } from "crypto";

import {
  buildCursorResult,
  validatePaginationOptions,
  type CursorPaginationOptions,
} from "@/lib/cursor-pagination";
import { prisma } from "@/lib/prisma";

/**
 * Records an initial address registration for a user.
 * Called when a user first registers a Stellar address.
 */
export async function recordInitialAddress(
  userId: string,
  stellarAddress: string
): Promise<void> {
  const registration = await prisma.registration.findUnique({
    where: { userId },
  });

  if (!registration || registration.deletedAt) return;

  await prisma.addressHistoryRecord.create({
    data: {
      userId,
      previousAddress: null,
      newAddress: stellarAddress,
      changeType: "initial",
    },
  });
}

/**
 * Records an address change for a user.
 * Called when a user updates their registered Stellar address.
 */
export async function recordAddressChange(
  userId: string,
  previousAddress: string | null,
  newAddress: string
): Promise<void> {
  await prisma.addressHistoryRecord.create({
    data: {
      userId,
      previousAddress,
      newAddress,
      changeType: "updated",
    },
  });
}

/**
 * Retrieves the complete address history for a user.
 */
export async function getAddressHistory(
  userId: string
): Promise<
  {
    stellarAddress: string;
    changeType: string;
    recordedAt: Date;
  }[]
> {
  const history = await prisma.addressHistoryRecord.findMany({
    where: { userId },
    select: {
      newAddress: true,
      changeType: true,
      recordedAt: true,
    },
    orderBy: { recordedAt: "desc" },
  });

  return history.map((record) => ({
    stellarAddress: record.newAddress,
    changeType: record.changeType,
    recordedAt: record.recordedAt,
  }));
}

export interface AddressHistoryEntryRecord {
  stellarAddress: string;
  changeType: string;
  recordedAt: Date;
}

export interface AddressHistoryPage {
  history: AddressHistoryEntryRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Retrieves one cursor-paginated page of history, newest first with `id` as
 * the tie-breaker so records sharing a timestamp have a stable order.
 */
export async function getAddressHistoryPage(
  userId: string,
  options: CursorPaginationOptions = {}
): Promise<AddressHistoryPage> {
  const rawLimit = options.limit;
  const { decodedCursor, limit } = validatePaginationOptions({
    cursor: options.cursor,
    limit:
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? rawLimit
        : undefined,
  });

  const rows = await prisma.addressHistoryRecord.findMany({
    where: { userId },
    select: {
      id: true,
      newAddress: true,
      changeType: true,
      recordedAt: true,
    },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(decodedCursor
      ? { cursor: { id: decodedCursor }, skip: 1 }
      : {}),
  });

  const page = buildCursorResult(rows, (row) => row.id, limit);

  return {
    history: page.data.map((row) => ({
      stellarAddress: row.newAddress,
      changeType: row.changeType,
      recordedAt: row.recordedAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export interface AddressHistoryViewer {
  isSelf: boolean;
  isMaintainer: boolean;
}

export interface ProjectedAddressHistoryEntry
  extends AddressHistoryEntryRecord {
  addressRedacted: boolean;
}

function pseudonymizeAddress(address: string): string {
  return `redacted:${createHash("sha256").update(address).digest("hex").slice(0, 12)}`;
}

/**
 * Pure field-level projection for one history entry. Self viewers get the raw
 * address; maintainers looking at someone else see a stable pseudonym. The
 * previous address is never exposed to any viewer.
 */
export function projectAddressHistoryEntry(
  record: AddressHistoryEntryRecord,
  viewer: AddressHistoryViewer
): ProjectedAddressHistoryEntry {
  if (viewer.isSelf) {
    return {
      stellarAddress: record.stellarAddress,
      changeType: record.changeType,
      recordedAt: record.recordedAt,
      addressRedacted: false,
    };
  }

  return {
    stellarAddress: viewer.isMaintainer
      ? pseudonymizeAddress(record.stellarAddress)
      : "[unavailable]",
    changeType: record.changeType,
    recordedAt: record.recordedAt,
    addressRedacted: true,
  };
}

/**
 * Gets the most recent address registration for a user.
 */
export async function getLatestAddress(userId: string): Promise<string | null> {
  const latest = await prisma.addressHistoryRecord.findFirst({
    where: { userId },
    select: { newAddress: true },
    orderBy: { recordedAt: "desc" },
  });

  return latest?.newAddress ?? null;
}

/**
 * Supported export serialization formats for address history.
 */
export type AddressHistoryExportFormat = "json" | "csv";

/**
 * Redaction modes for address-history exports. `self` exposes the caller's
 * own addresses verbatim; `admin` applies the documented masking policy so
 * operator-facing exports never leak raw addresses.
 */
export type AddressHistoryRedactionMode = "self" | "admin";

/**
 * Stable error codes surfaced by the address-history export flow.
 */
export type AddressHistoryExportErrorCode =
  | "invalid_format"
  | "invalid_redaction_mode"
  | "empty_history"
  | "forbidden";

/**
 * Raised when an export request cannot be fulfilled. Carries a stable code
 * so API routes can map it to a deterministic HTTP response.
 */
export class AddressHistoryExportError extends Error {
  readonly code: AddressHistoryExportErrorCode;

  constructor(code: AddressHistoryExportErrorCode, message: string) {
    super(message);
    this.name = "AddressHistoryExportError";
    this.code = code;
  }
}

const EXPORT_FORMATS: readonly AddressHistoryExportFormat[] = ["json", "csv"];
const REDACTION_MODES: readonly AddressHistoryRedactionMode[] = [
  "self",
  "admin",
];

/**
 * Normalizes and validates a requested export format. Defaults to JSON when
 * unspecified; rejects unknown formats with a stable error.
 */
export function parseExportFormat(
  raw: unknown
): AddressHistoryExportFormat {
  if (raw === undefined || raw === null || raw === "") return "json";
  if (typeof raw !== "string" || !EXPORT_FORMATS.includes(raw as AddressHistoryExportFormat)) {
    throw new AddressHistoryExportError(
      "invalid_format",
      `Unsupported export format. Expected one of: ${EXPORT_FORMATS.join(", ")}.`
    );
  }
  return raw as AddressHistoryExportFormat;
}

/**
 * Normalizes and validates a requested redaction mode. Defaults to `self`
 * when unspecified; rejects unknown modes with a stable error.
 */
export function parseRedactionMode(
  raw: unknown
): AddressHistoryRedactionMode {
  if (raw === undefined || raw === null || raw === "") return "self";
  if (
    typeof raw !== "string" ||
    !REDACTION_MODES.includes(raw as AddressHistoryRedactionMode)
  ) {
    throw new AddressHistoryExportError(
      "invalid_redaction_mode",
      `Unsupported redaction mode. Expected one of: ${REDACTION_MODES.join(", ")}.`
    );
  }
  return raw as AddressHistoryRedactionMode;
}

/**
 * Derives the redaction mode from the authenticated viewer. Self viewers
 * export their own addresses; maintainers exporting another user's history
 * use the admin masking policy.
 */
export function resolveRedactionMode(
  viewer: AddressHistoryViewer
): AddressHistoryRedactionMode {
  return viewer.isSelf ? "self" : "admin";
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serializes address history records into the requested export format.
 * Reuses the same record shape returned by `getAddressHistory`. When a
 * redaction mode is supplied, each address is projected through the
 * documented masking policy before serialization.
 */
export function serializeAddressHistory(
  records: Awaited<ReturnType<typeof getAddressHistory>>,
  format: AddressHistoryExportFormat,
  redactionMode: AddressHistoryRedactionMode = "self"
): { contentType: string; body: string } {
  const projected = records.map((record) => {
    if (redactionMode === "self") return record;
    return {
      stellarAddress: pseudonymizeAddress(record.stellarAddress),
      changeType: record.changeType,
      recordedAt: record.recordedAt,
    };
  });

  if (format === "csv") {
    const header = "stellarAddress,changeType,recordedAt";
    const rows = projected.map((record) =>
      [
        escapeCsvField(record.stellarAddress),
        escapeCsvField(record.changeType),
        escapeCsvField(record.recordedAt.toISOString()),
      ].join(",")
    );
    return {
      contentType: "text/csv; charset=utf-8",
      body: [header, ...rows].join("\n"),
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      records: projected.map((record) => ({
        stellarAddress: record.stellarAddress,
        changeType: record.changeType,
        recordedAt: record.recordedAt.toISOString(),
      })),
    }),
  };
}

/**
 * Builds a scoped export payload for a single user's address history.
 * Enforces that the caller only exports their own history and fails with a
 * stable error when there is nothing to export.
 */
export async function buildAddressHistoryExport(
  userId: string,
  requestedUserId: string | null | undefined,
  rawFormat: unknown,
  rawRedactionMode?: unknown
): Promise<{
  format: AddressHistoryExportFormat;
  redactionMode: AddressHistoryRedactionMode;
  contentType: string;
  body: string;
  filename: string;
}> {
  if (!userId) {
    throw new AddressHistoryExportError(
      "empty_history",
      "Authenticated user is required to export address history."
    );
  }

  const redactionMode = parseRedactionMode(rawRedactionMode);

  if (requestedUserId && requestedUserId !== userId) {
    throw new AddressHistoryExportError(
      "forbidden",
      "You may only export your own address history."
    );
  }

  const format = parseExportFormat(rawFormat);
  const records = await getAddressHistory(userId);

  if (records.length === 0) {
    throw new AddressHistoryExportError(
      "empty_history",
      "No address history is available to export."
    );
  }

  const { contentType, body } = serializeAddressHistory(
    records,
    format,
    redactionMode
  );

  return {
    format,
    redactionMode,
    contentType,
    body,
    filename: `address-history.${format}`,
  };
}
