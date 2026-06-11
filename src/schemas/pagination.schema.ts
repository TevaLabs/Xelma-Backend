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
