import { Decimal } from "@prisma/client/runtime/library";

/**
 * Utility functions for decimal-safe monetary calculations.
 * All monetary values in the DB are stored as Decimal(20,8).
 * These helpers prevent floating-point drift in balance/payout flows.
 */

/** Convert any numeric-like value to a Prisma Decimal */
export function toDecimal(value: number | string | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  return new Decimal(typeof value === "number" ? value.toString() : value);
}

/** Safely convert a Prisma Decimal to a JS number (for JSON serialization) */
export function toNumber(value: Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return value.toNumber();
}

/** Add two decimal values */
export function decAdd(a: Decimal | number, b: Decimal | number): Decimal {
  return toDecimal(a).add(toDecimal(b));
}

/** Subtract b from a */
export function decSub(a: Decimal | number, b: Decimal | number): Decimal {
  return toDecimal(a).sub(toDecimal(b));
}

/** Multiply two decimal values */
export function decMul(a: Decimal | number, b: Decimal | number): Decimal {
  return toDecimal(a).mul(toDecimal(b));
}

/** Divide a by b (returns Decimal) */
export function decDiv(a: Decimal | number, b: Decimal | number): Decimal {
  return toDecimal(a).div(toDecimal(b));
}

/** Check if a > b */
export function decGt(a: Decimal | number, b: Decimal | number): boolean {
  return toDecimal(a).gt(toDecimal(b));
}

/** Check if a < b */
export function decLt(a: Decimal | number, b: Decimal | number): boolean {
  return toDecimal(a).lt(toDecimal(b));
}

/** Check if a === b */
export function decEq(a: Decimal | number, b: Decimal | number): boolean {
  return toDecimal(a).eq(toDecimal(b));
}

/** Format a Decimal to a fixed-precision string (default 2 decimals) */
export function decFixed(value: Decimal | number, places: number = 2): string {
  return toDecimal(value).toFixed(places);
}
