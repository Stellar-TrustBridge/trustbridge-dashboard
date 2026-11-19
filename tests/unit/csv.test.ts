import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeCsvCell,
  buildCsv,
  buildCsvFilename,
  buildJson,
  buildJsonFilename,
  downloadCsv,
  downloadJson,
} from "@/lib/csv";

describe("CSV helpers", () => {
  it("escapes quotes in CSV cells", () => {
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
  });

  it("handles null and undefined", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it("builds CSV with headers and rows", () => {
    const csv = buildCsv(
      ["name", "value"],
      [
        ["alice", 100],
        ["bob", 200],
      ]
    );
    expect(csv).toMatchSnapshot();
  });

  it("builds CSV filename with date", () => {
    const date = new Date("2024-06-15");
    expect(buildCsvFilename("wave", date)).toBe("wave-2024-06-15.csv");
  });
});

describe("CSV formula injection guards", () => {
  it.each([
    ['=IMPORTXML("http://evil")', `"'=IMPORTXML(""http://evil"")"`],
    ["+cmd|' /C calc'!A0", `"'+cmd|' /C calc'!A0"`],
    ["-cmd", `"'-cmd"`],
    ["@SUM(1,2)", `"'@SUM(1,2)"`],
    ["  =2+3", `"'  =2+3"`],
    ["\t=cmd", `"'\t=cmd"`],
    ["\r=cmd", `"'\r=cmd"`],
    ["\u0000=cmd", `"'\u0000=cmd"`],
  ])("neutralizes %s", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it("does not mangle genuine numeric values", () => {
    expect(escapeCsvCell(-12.5)).toBe('"-12.5"');
    expect(escapeCsvCell("-1e3")).toBe('"-1e3"');
    expect(escapeCsvCell("100.5")).toBe('"100.5"');
    expect(escapeCsvCell(0)).toBe('"0"');
  });

  it("keeps quote escaping and null/undefined behaviour", () => {
    expect(escapeCsvCell('=CMD("x")')).toBe(`"'=CMD(""x"")"`);
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it("applies guards to every cell in buildCsv", () => {
    const csv = buildCsv(
      ["username", "note"],
      [
        ["=IMPORTXML(x)", "+cmd"],
        ["alice", "-cmd"],
      ]
    );
    expect(csv).toContain('"\'=IMPORTXML(x)","\'+cmd"');
    expect(csv).toContain('"alice","\'-cmd"');
  });
});

describe("JSON helpers", () => {
  it("builds JSON from headers and rows", () => {
    const json = buildJson(
      ["name", "value"],
      [
        ["alice", 100],
        ["bob", 200],
      ]
    );
    expect(json).toMatchSnapshot();
  });

  it("builds JSON filename with date", () => {
    const date = new Date("2024-06-15");
    expect(buildJsonFilename("wave", date)).toBe("wave-2024-06-15.json");
  });
});

describe("CSV stats validation", () => {
  it("builds CSV with incremental stats counters", () => {
    const headers = ["id", "username", "status", "ready_count", "export_version"];
    const rows = [
      ["1", "alice", "ready", "1", "1"],
      ["2", "bob", "not_ready", "1", "1"],
      ["3", "charlie", "ready", "2", "1"],
    ];

    const csv = buildCsv(headers, rows);

    // Verify CSV structure (cells are always quoted)
    expect(csv).toContain('"id","username","status","ready_count","export_version"');
    expect(csv).toContain("alice");
    expect(csv).toContain("bob");
    expect(csv).toContain("charlie");
  });

  it("validates CSV row count consistency", () => {
    const headers = ["id", "username", "status"];
    const rows = [
      ["1", "alice", "ready"],
      ["2", "bob", "not_ready"],
    ];

    const csv = buildCsv(headers, rows);
    const lines = csv.split("\n");

    // Should have header + 2 rows
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('"id","username","status"');
  });

  it("handles special characters in stats export", () => {
    const headers = ["id", "username", "note"];
    const rows = [["1", "alice", "Contains, comma and \"quotes\""]];

    const csv = buildCsv(headers, rows);

    // Special characters should be properly escaped
    expect(csv).toContain('Contains, comma and ""quotes""');
  });
});
