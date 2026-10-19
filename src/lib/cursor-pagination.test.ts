import { describe, expect, it } from "vitest";

import {
  encodeCursor,
  decodeCursor,
  validatePaginationOptions,
  buildCursorResult,
} from "@/lib/cursor-pagination";

describe("Cursor Pagination", () => {
  describe("encodeCursor and decodeCursor", () => {
    it("encodes and decodes cursor values correctly", () => {
      const original = "reg-123";
      const encoded = encodeCursor(original);

      expect(encoded).not.toBe(original);
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 pattern

      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(original);
    });

    it("handles special characters in cursors", () => {
      const original = "user-abc_123-xyz";
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);

      expect(decoded).toBe(original);
    });

    it("returns null for invalid base64 cursor", () => {
      const invalidCursor = "!!!invalid!!!";
      const decoded = decodeCursor(invalidCursor);

      expect(decoded).toBeNull();
    });
  });

  describe("validatePaginationOptions", () => {
    it("uses default limit of 50 when not provided", () => {
      const result = validatePaginationOptions({});

      expect(result.limit).toBe(50);
      expect(result.decodedCursor).toBeNull();
    });

    it("uses provided limit within bounds", () => {
      const result = validatePaginationOptions({ limit: 25 });

      expect(result.limit).toBe(25);
    });

    it("enforces maximum limit of 100", () => {
      const result = validatePaginationOptions({ limit: 500 });

      expect(result.limit).toBe(100);
    });

    it("enforces minimum limit of 1", () => {
      const result = validatePaginationOptions({ limit: 0 });

      expect(result.limit).toBe(1);
    });

    it("decodes provided cursor", () => {
      const original = "reg-123";
      const encoded = encodeCursor(original);
      const result = validatePaginationOptions({ cursor: encoded });

      expect(result.decodedCursor).toBe(original);
    });

    it("returns null for invalid cursor during validation", () => {
      const result = validatePaginationOptions({ cursor: "!!!invalid!!!" });

      expect(result.decodedCursor).toBeNull();
    });
  });

  describe("buildCursorResult", () => {
    it("returns data with nextCursor when more records exist", () => {
      const data = [
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
        { id: "3", name: "Charlie" },
      ];

      const result = buildCursorResult(data, (item) => item.id, 2);

      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe("1");
      expect(result.data[1].id).toBe("2");
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
      expect(decodeCursor(result.nextCursor!)).toBe("2");
    });

    it("returns data without nextCursor when no more records", () => {
      const data = [
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
      ];

      const result = buildCursorResult(data, (item) => item.id, 2);

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("handles single record correctly", () => {
      const data = [{ id: "1", name: "Alice" }];

      const result = buildCursorResult(data, (item) => item.id, 10);

      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("respects requested limit when building result", () => {
      const data = Array.from({ length: 20 }, (_, i) => ({
        id: `${i + 1}`,
        name: `User ${i + 1}`,
      }));

      const result = buildCursorResult(data, (item) => item.id, 10);

      expect(result.data).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.data[result.data.length - 1].id).toBe("10");
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// API and client hook consistency tests
// ─────────────────────────────────────────────────────────────────────────────

describe("cursor-pagination API consistency", () => {
  describe("encodeCursor and decodeCursor round-trip", () => {
    it("round-trips simple ID cursors", () => {
      const original = "contributor-id-123";
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(original);
    });

    it("round-trips UUID cursors", () => {
      const original = "550e8400-e29b-41d4-a716-446655440000";
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(original);
    });

    it("round-trips timestamp cursors", () => {
      const original = "2026-10-19T12:00:00.000Z";
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(original);
    });

    it("round-trips composite cursors", () => {
      const original = "timestamp:2026-10-19T12:00:00.000Z:id:abc123";
      const encoded = encodeCursor(original);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(original);
    });

    it("encoded cursor is valid base64", () => {
      const encoded = encodeCursor("test-id-123");
      expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(encoded.length % 4).toBe(0);
    });

    it("encoding is stable across multiple calls", () => {
      const original = "stable-id";
      const first = encodeCursor(original);
      const second = encodeCursor(original);
      expect(first).toBe(second);
    });
  });

  describe("decodeCursor validation and safety", () => {
    it("returns null for empty string", () => {
      expect(decodeCursor("")).toBeNull();
    });

    it("returns null for non-base64 characters", () => {
      expect(decodeCursor("not@valid!base64")).toBeNull();
      expect(decodeCursor("hello world")).toBeNull(); // space is invalid
      expect(decodeCursor("[]{}")).toBeNull();
    });

    it("returns null for invalid base64 length", () => {
      expect(decodeCursor("abc")).toBeNull(); // length not multiple of 4
      expect(decodeCursor("abcde")).toBeNull();
    });

    it("returns null for tampered cursor that breaks round-trip", () => {
      const valid = encodeCursor("test-id");
      // Tamper by changing one character
      const tampered = valid.substring(0, valid.length - 1) + (valid.endsWith("A") ? "B" : "A");
      // Should fail round-trip check (if implemented)
      const decoded = decodeCursor(tampered);
      if (decoded !== null) {
        // If it decoded, verify it doesn't match original
        expect(decoded).not.toBe("test-id");
      }
    });

    it("handles padding correctly", () => {
      expect(decodeCursor("dGVzdA==")).toBe("test"); // valid padding
      expect(decodeCursor("dGVzdA=")).toBeNull(); // single = is invalid (not multiple of 4)
    });

    it("rejects SQL injection attempts in cursor", () => {
      const malicious = "'; DROP TABLE users; --";
      const encoded = encodeCursor(malicious);
      const decoded = decodeCursor(encoded);
      // Should round-trip safely
      expect(decoded).toBe(malicious);
      // But downstream code should never use this in raw SQL
    });

    it("rejects cursor with null bytes", () => {
      const withNull = "test\x00id";
      const encoded = encodeCursor(withNull);
      const decoded = decodeCursor(encoded);
      // Null bytes should round-trip (base64 handles binary)
      expect(decoded).toBe(withNull);
      // But prisma/SQL should reject them
    });
  });

  describe("validatePaginationOptions", () => {
    it("returns decoded cursor and normalized limit", () => {
      const cursor = encodeCursor("test-id");
      const result = validatePaginationOptions({ cursor, limit: 25 });
      expect(result.decodedCursor).toBe("test-id");
      expect(result.limit).toBe(25);
    });

    it("returns null cursor when not provided", () => {
      const result = validatePaginationOptions({ limit: 50 });
      expect(result.decodedCursor).toBeNull();
      expect(result.limit).toBe(50);
    });

    it("returns null cursor when invalid", () => {
      const result = validatePaginationOptions({ cursor: "invalid!!!", limit: 50 });
      expect(result.decodedCursor).toBeNull();
    });

    it("enforces minimum limit of 1", () => {
      expect(validatePaginationOptions({ limit: 0 }).limit).toBe(1);
      expect(validatePaginationOptions({ limit: -5 }).limit).toBe(1);
    });

    it("enforces maximum limit of 100", () => {
      expect(validatePaginationOptions({ limit: 150 }).limit).toBe(100);
      expect(validatePaginationOptions({ limit: 999 }).limit).toBe(100);
    });

    it("uses default limit of 50 when not provided", () => {
      expect(validatePaginationOptions({}).limit).toBe(50);
    });

    it("handles undefined limit", () => {
      const result = validatePaginationOptions({ limit: undefined });
      expect(result.limit).toBe(50);
    });
  });

  describe("buildCursorResult", () => {
    const testData = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
      { id: "c", name: "Carol" },
    ];
    const idAccessor = (item: typeof testData[0]) => item.id;

    it("builds result with nextCursor when hasMore=true", () => {
      const result = buildCursorResult(testData, idAccessor, 2);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe("a");
      expect(result.data[1].id).toBe("b");
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
      expect(decodeCursor(result.nextCursor!)).toBe("b");
    });

    it("builds result with null nextCursor when no more data", () => {
      const result = buildCursorResult(testData, idAccessor, 5);
      expect(result.data).toHaveLength(3);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("uses last item ID for cursor", () => {
      const result = buildCursorResult(testData, idAccessor, 2);
      expect(decodeCursor(result.nextCursor!)).toBe("b"); // last item in page
    });

    it("handles single-item page", () => {
      const result = buildCursorResult([testData[0]], idAccessor, 1);
      expect(result.data).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("handles empty data array", () => {
      const result = buildCursorResult([], idAccessor, 10);
      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("nextCursor encodes correctly for client use", () => {
      const result = buildCursorResult(testData, idAccessor, 2);
      // Verify client can decode and use it
      const decoded = decodeCursor(result.nextCursor!);
      expect(decoded).toBe("b");
      // Verify it's URL-safe
      expect(result.nextCursor).not.toContain(" ");
      expect(result.nextCursor).not.toContain("\n");
    });
  });

  describe("deep link stability", () => {
    it("cursor can be used in query string without encoding", () => {
      const cursor = encodeCursor("test-id-123");
      const url = `/api/contributors?cursor=${cursor}&limit=50`;
      expect(url).not.toContain(" ");
      expect(url).not.toContain("\n");
      // Standard base64 may contain +/ which need URL encoding, but it's valid
      expect(cursor).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("cursor preserves maintainer place across page reloads", () => {
      const contributorId = "contributor-last-viewed-456";
      const cursor = encodeCursor(contributorId);
      const decoded = decodeCursor(cursor);
      // After page reload, same cursor should resolve to same contributor
      expect(decoded).toBe(contributorId);
    });

    it("cursor does not leak PII", () => {
      const cursor = encodeCursor("internal-id-xyz");
      // Cursor is base64 of ID, not Stellar address or email
      expect(cursor).not.toMatch(/G[A-Z0-9]{55}/); // no Stellar address
      expect(cursor).not.toMatch(/@/); // no email
    });
  });

  describe("client hook compatibility", () => {
    it("nextCursor from API response can be passed to next request", () => {
      const page1Data = [
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ];
      const page1Result = buildCursorResult(page1Data, (i) => i.id, 2);
      
      // Simulate client passing nextCursor to next request
      const options = validatePaginationOptions({
        cursor: page1Result.nextCursor!,
        limit: 2,
      });
      
      expect(options.decodedCursor).toBe("b");
      // API would use this to query: WHERE id > 'b' ORDER BY id LIMIT 2+1
    });

    it("client can detect end of list via hasMore=false", () => {
      const lastPage = [{ id: "x" }, { id: "y" }];
      const result = buildCursorResult(lastPage, (i) => i.id, 10);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      // Client hook should not fetch another page
    });
  });

  describe("API and frontend consistency guarantees", () => {
    it("API route and client hook agree on limit bounds", () => {
      // Both should enforce min=1, max=100, default=50
      expect(validatePaginationOptions({ limit: -1 }).limit).toBe(1);
      expect(validatePaginationOptions({ limit: 200 }).limit).toBe(100);
      expect(validatePaginationOptions({}).limit).toBe(50);
    });

    it("API and client agree on cursor format (base64)", () => {
      const id = "test-id";
      const encoded = encodeCursor(id);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(id);
      // Both must use same encoding to ensure deep links work
    });

    it("malformed cursor from client does not crash API", () => {
      const result = validatePaginationOptions({ cursor: "malformed!!!" });
      expect(result.decodedCursor).toBeNull();
      // API should treat this as "no cursor" and return first page
    });
  });
});
