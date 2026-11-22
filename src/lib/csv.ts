export const UTF8_BOM = "\uFEFF";

export interface CsvBuildOptions {
  /**
   * Prepend a UTF-8 BOM so Excel detects the encoding and avoids mojibake.
   * Defaults to `true` for Excel compatibility; pass `false` to opt out.
   */
  bom?: boolean;
}

export function escapeCsvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function buildCsv(
  headers: string[],
  rows: unknown[][],
  options: CsvBuildOptions = {},
): string {
  const body = [headers, ...rows]
    .map((line) => line.map(escapeCsvCell).join(","))
    .join("\n");
  // BOM is prepended after serialization so it never lands inside a cell and
  // the formula-injection escaping above still applies to every cell.
  return options.bom === false ? body : `${UTF8_BOM}${body}`;
}

export function buildCsvFilename(prefix: string, date = new Date()): string {
  return `${prefix}-${date.toISOString().slice(0, 10)}.csv`;
}

export function buildJson(headers: string[], rows: unknown[][]): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

export function buildJsonFilename(prefix: string, date = new Date()): string {
  return `${prefix}-${date.toISOString().slice(0, 10)}.json`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
