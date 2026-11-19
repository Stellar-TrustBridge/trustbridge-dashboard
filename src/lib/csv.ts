const FORMULA_OPERATORS = new Set(["=", "+", "-", "@", "\t", "\r"]);
const LEADING_NOISE = /[\s\u0000-\u001f\ufeff]/;
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function neutralizeCsvFormula(value: string): string {
  if (!value) return value;

  let index = 0;
  while (index < value.length && LEADING_NOISE.test(value[index])) index++;
  const first = value[index];
  if (!first || !FORMULA_OPERATORS.has(first)) return value;
  if (NUMERIC.test(value.trim())) return value;

  return `'${value}`;
}

export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = neutralizeCsvFormula(raw);
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows]
    .map((line) => line.map(escapeCsvCell).join(","))
    .join("\n");
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
