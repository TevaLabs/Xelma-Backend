/**
 * Shared pagination utilities for Xelma API.
 *
 * Supports two pagination modes:
 *   - Offset/limit  – backward-compatible, used by existing clients
 *   - Cursor        – keyset-based, efficient for high-volume lists
 *
 * Cursor encoding: base64url of a JSON object so the wire format is
 * opaque to clients and we can change the internal fields freely.
 */

// ---------------------------------------------------------------------------
// Generic response envelopes
// ---------------------------------------------------------------------------

/** Offset/limit page metadata echoed back in every list response. */
export interface OffsetMeta {
  limit: number;
  offset: number;
  total: number;
  /** True when there are more rows beyond this page. */
  hasNextPage: boolean;
}

/** Cursor page metadata. `nextCursor` is null on the last page. */
export interface CursorMeta {
  limit: number;
  /** Opaque token to pass as `cursor` on the next request. null = last page. */
  nextCursor: string | null;
  /** True when there are more rows beyond this page. */
  hasNextPage: boolean;
}

/** Generic offset-paginated response wrapper. */
export interface OffsetPage<T> {
  data: T[];
  pagination: OffsetMeta;
}

/** Generic cursor-paginated response wrapper. */
export interface CursorPage<T> {
  data: T[];
  pagination: CursorMeta;
}

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary object into an opaque base64url cursor string.
 * Throws if the value cannot be JSON-serialised.
 */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Decode a cursor string back to its original object.
 * Returns null if the string is missing, malformed, or not valid JSON.
 */
export function decodeCursor<T extends Record<string, unknown>>(
  cursor: string | undefined | null,
): T | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Offset helpers
// ---------------------------------------------------------------------------

/**
 * Build the OffsetMeta object from query params + total count.
 */
export function buildOffsetMeta(
  limit: number,
  offset: number,
  total: number,
): OffsetMeta {
  return {
    limit,
    offset,
    total,
    hasNextPage: offset + limit < total,
  };
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Build the CursorMeta object.
 *
 * @param limit      - page size requested
 * @param rows       - the rows returned (length ≤ limit + 1 sentinel trick)
 * @param makeCursor - function that turns the last real row into a cursor value
 * @param fetched    - how many rows were actually fetched (limit + 1 sentinel)
 */
export function buildCursorMeta<T>(
  limit: number,
  rows: T[],
  makeCursor: (lastRow: T) => Record<string, unknown>,
): CursorMeta {
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasNextPage && pageRows.length > 0
      ? encodeCursor(makeCursor(pageRows[pageRows.length - 1]))
      : null;

  return { limit, nextCursor, hasNextPage };
}

/**
 * Trim the sentinel row off the result set.
 * Always call this after buildCursorMeta so the extra row is removed.
 */
export function trimSentinel<T>(rows: T[], limit: number): T[] {
  return rows.length > limit ? rows.slice(0, limit) : rows;
}
