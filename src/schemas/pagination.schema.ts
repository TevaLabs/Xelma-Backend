/**
 * Reusable Zod schemas for pagination query parameters.
 *
 * Import the appropriate schema and pass it to validate(schema, 'query').
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared coercion helper
// ---------------------------------------------------------------------------

/** Coerce a query-string value to a positive integer. */
const coerceInt = (fallback: number) =>
  z
    .preprocess((v) => {
      if (typeof v === "string") return Number(v);
      return v;
    }, z.number().int())
    .default(fallback);

// ---------------------------------------------------------------------------
// Offset/limit schema
// ---------------------------------------------------------------------------

/**
 * Standard offset/limit pagination.
 * Accepts: limit (1–100, default 20), offset (≥0, default 0).
 */
export const offsetPaginationSchema = z.object({
  limit: coerceInt(20).pipe(z.number().int().min(1).max(100)),
  offset: coerceInt(0).pipe(z.number().int().min(0)),
});

export type OffsetPaginationParams = z.infer<typeof offsetPaginationSchema>;

// ---------------------------------------------------------------------------
// Cursor schema
// ---------------------------------------------------------------------------

/**
 * Cursor-based pagination.
 * Accepts: limit (1–100, default 20), cursor (opaque string, optional).
 */
export const cursorPaginationSchema = z.object({
  limit: coerceInt(20).pipe(z.number().int().min(1).max(100)),
  cursor: z.string().optional(),
});

export type CursorPaginationParams = z.infer<typeof cursorPaginationSchema>;

// ---------------------------------------------------------------------------
// Combined schema (supports both modes simultaneously)
// ---------------------------------------------------------------------------

/**
 * Unified pagination schema that accepts both offset and cursor params.
 * When `cursor` is present the service should use cursor mode;
 * otherwise fall back to offset mode.
 */
export const unifiedPaginationSchema = z.object({
  limit: coerceInt(20).pipe(z.number().int().min(1).max(100)),
  offset: coerceInt(0).pipe(z.number().int().min(0)),
  cursor: z.string().optional(),
});

export type UnifiedPaginationParams = z.infer<typeof unifiedPaginationSchema>;

// ---------------------------------------------------------------------------
// Cursor encoding utilities
// ---------------------------------------------------------------------------

/**
 * Encodes a `createdAt` Date into a URL-safe opaque cursor string.
 *
 * The cursor is base64url-encoded so it is:
 *   - URL-safe (no `+`, `/`, or `=` padding)
 *   - Opaque to clients (they should treat it as a black box)
 *   - Stable (same Date always produces the same cursor)
 *
 * @example
 *   encodeCursor(new Date("2024-06-01T12:00:00.000Z"))
 *   // → "MjAyNC0wNi0wMVQxMjowMDowMC4wMDBa"
 */
export function encodeCursor(createdAt: Date): string {
  return Buffer.from(createdAt.toISOString()).toString("base64url");
}

/**
 * Decodes an opaque cursor string back to a Date.
 * Throws a `CursorDecodeError` if the cursor is malformed or represents
 * an invalid date — callers should catch this and return HTTP 400.
 *
 * @example
 *   decodeCursor("MjAyNC0wNi0wMVQxMjowMDowMC4wMDBa")
 *   // → Date("2024-06-01T12:00:00.000Z")
 */
export function decodeCursor(cursor: string): Date {
  let iso: string;
  try {
    iso = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new CursorDecodeError(`Cannot base64url-decode cursor: "${cursor}"`);
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new CursorDecodeError(`Cursor decoded to invalid date: "${iso}"`);
  }
  return d;
}

/** Thrown by `decodeCursor` when a cursor cannot be decoded. */
export class CursorDecodeError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "CursorDecodeError";
  }
}