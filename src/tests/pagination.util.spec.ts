/**
 * Unit tests for src/utils/pagination.util.ts
 *
 * Covers cursor encoding/decoding, offset meta, cursor meta, and the
 * sentinel-trim helper.
 */
import { describe, it, expect } from "@jest/globals";
import {
  encodeCursor,
  decodeCursor,
  buildOffsetMeta,
  buildOffsetPage,
  buildCursorMeta,
  buildUnifiedCursorPagination,
  buildUnifiedOffsetPagination,
  trimSentinel,
} from "../utils/pagination.util";

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor
// ---------------------------------------------------------------------------

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a simple object", () => {
    const value = { createdAt: "2026-06-01T00:00:00.000Z", id: "abc-123" };
    const cursor = encodeCursor(value);
    expect(typeof cursor).toBe("string");
    expect(decodeCursor(cursor)).toEqual(value);
  });

  it("produces a base64url string (no +, /, = padding)", () => {
    const cursor = encodeCursor({ id: "test" });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("returns null for undefined cursor", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("returns null for null cursor", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for a non-base64url garbage string", () => {
    expect(decodeCursor("not-valid-cursor!!!")).toBeNull();
  });

  it("returns null for valid base64url that is not JSON", () => {
    const notJson = Buffer.from("hello world").toString("base64url");
    expect(decodeCursor(notJson)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildOffsetMeta
// ---------------------------------------------------------------------------

describe("buildOffsetMeta", () => {
  it("hasNextPage is true when more rows exist", () => {
    const meta = buildOffsetMeta(10, 0, 25);
    expect(meta.hasNextPage).toBe(true);
    expect(meta.limit).toBe(10);
    expect(meta.offset).toBe(0);
    expect(meta.total).toBe(25);
  });

  it("hasNextPage is false on the last page", () => {
    const meta = buildOffsetMeta(10, 20, 25);
    expect(meta.hasNextPage).toBe(false);
  });

  it("hasNextPage is false when offset + limit equals total exactly", () => {
    const meta = buildOffsetMeta(10, 15, 25);
    expect(meta.hasNextPage).toBe(false);
  });

  it("hasNextPage is false when total is 0", () => {
    const meta = buildOffsetMeta(20, 0, 0);
    expect(meta.hasNextPage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unified pagination (issue #340)
// ---------------------------------------------------------------------------

describe("buildUnifiedOffsetPagination", () => {
  it("exposes the canonical offset keys", () => {
    expect(buildUnifiedOffsetPagination(10, 0, 25)).toEqual({
      limit: 10,
      offset: 0,
      total: 25,
      hasNextPage: true,
      totalPages: 3,
    });
  });

  it("reports no next page on the last page", () => {
    const meta = buildUnifiedOffsetPagination(10, 20, 25);
    expect(meta.hasNextPage).toBe(false);
  });

  it("handles an empty result set", () => {
    expect(buildUnifiedOffsetPagination(20, 0, 0)).toEqual({
      limit: 20,
      offset: 0,
      total: 0,
      hasNextPage: false,
      totalPages: 0,
    });
  });

  it("never emits cursor-only keys", () => {
    const meta = buildUnifiedOffsetPagination(10, 0, 5);
    expect(meta.nextCursor).toBeUndefined();
  });
});

describe("buildUnifiedCursorPagination", () => {
  it("exposes the canonical cursor keys", () => {
    expect(buildUnifiedCursorPagination(10, "abc")).toEqual({
      limit: 10,
      nextCursor: "abc",
      hasNextPage: true,
    });
  });

  it("reports the last page when the cursor is null", () => {
    expect(buildUnifiedCursorPagination(10, null)).toEqual({
      limit: 10,
      nextCursor: null,
      hasNextPage: false,
    });
  });

  it("never emits offset-only keys", () => {
    const meta = buildUnifiedCursorPagination(10, null);
    expect(meta.offset).toBeUndefined();
    expect(meta.total).toBeUndefined();
    expect(meta.totalPages).toBeUndefined();
  });
});

describe("buildOffsetPage", () => {
  it("returns data with pagination { limit, offset, total }", () => {
    const page = buildOffsetPage([{ id: 1 }, { id: 2 }], 10, 0, 2);
    expect(page).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      pagination: { limit: 10, offset: 0, total: 2 },
    });
  });

  it("keeps empty data with total 0", () => {
    const page = buildOffsetPage([], 20, 40, 0);
    expect(page.data).toEqual([]);
    expect(page.pagination).toEqual({ limit: 20, offset: 40, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildCursorMeta + trimSentinel
// ---------------------------------------------------------------------------

describe("buildCursorMeta", () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, createdAt: new Date() }));

  it("hasNextPage is false when rows <= limit", () => {
    const rows = makeRows(5);
    const meta = buildCursorMeta(10, rows, (r) => ({ id: r.id }));
    expect(meta.hasNextPage).toBe(false);
    expect(meta.nextCursor).toBeNull();
  });

  it("hasNextPage is true when rows > limit (sentinel present)", () => {
    const rows = makeRows(11); // limit=10, sentinel=1
    const meta = buildCursorMeta(10, rows, (r) => ({ id: r.id }));
    expect(meta.hasNextPage).toBe(true);
    expect(meta.nextCursor).not.toBeNull();
  });

  it("nextCursor decodes to the last real row's data", () => {
    const rows = makeRows(11);
    const meta = buildCursorMeta(10, rows, (r) => ({ id: r.id }));
    const decoded = decodeCursor<{ id: string }>(meta.nextCursor!);
    // The last real row is index 9 (rows[9])
    expect(decoded?.id).toBe("id-9");
  });

  it("nextCursor is null when rows is empty", () => {
    const meta = buildCursorMeta(10, [], (r: any) => ({ id: r.id }));
    expect(meta.nextCursor).toBeNull();
    expect(meta.hasNextPage).toBe(false);
  });
});

describe("trimSentinel", () => {
  it("removes the extra row when rows.length > limit", () => {
    const rows = [1, 2, 3, 4, 5, 6]; // limit=5, sentinel=6
    expect(trimSentinel(rows, 5)).toHaveLength(5);
  });

  it("returns rows unchanged when rows.length <= limit", () => {
    const rows = [1, 2, 3];
    expect(trimSentinel(rows, 5)).toHaveLength(3);
  });

  it("returns empty array unchanged", () => {
    expect(trimSentinel([], 10)).toHaveLength(0);
  });
});
