import { Decimal } from "@prisma/client/runtime/library";

/**
 * Utility functions for decimal-safe monetary calculations.
 * All monetary values in the DB are stored as Decimal(20,8).
 * These helpers prevent floating-point drift in balance/payout flows.
 */

/** Convert any numeric-like value to a Prisma Decimal */
export function toDecimal(
  value: number | string | Decimal | { toString(): string },
): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === "number") return new Decimal(value.toString());
  if (typeof value === "string") return new Decimal(value);
  return new Decimal(value.toString());
}

/**
 * Canonical API scale for balances, stakes, payouts, and pools.
 * Matches Prisma Decimal(20, 8).
 */
export const MONEY_SCALE = 8;
export const ZERO_MONEY = "0.00000000";

/**
 * Largest value a `Decimal(18, 8)` column can hold (price/pool/bet columns).
 * Request bodies must stay inside this bound or Prisma silently rounds them.
 */
export const DECIMAL_18_8_MAX = "9999999999.99999999";

/**
 * True when `value` fits in a numeric column with `places` fractional digits.
 * Uses Decimal string parsing so 1.123456789 is rejected while 0.12 is not.
 */
export function fitsDecimalPlaces(value: number, places: number = MONEY_SCALE): boolean {
  if (!Number.isFinite(value)) return false;
  return toDecimal(value.toString()).decimalPlaces() <= places;
}

/** Safely convert a Prisma Decimal to a JS number (internal math / DB increments only — never API JSON) */
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

/** Check if a >= b */
export function decGte(a: Decimal | number, b: Decimal | number): boolean {
  return toDecimal(a).gte(toDecimal(b));
}

/** Check if a <= b */
export function decLte(a: Decimal | number, b: Decimal | number): boolean {
  return toDecimal(a).lte(toDecimal(b));
}

/** Format a Decimal to a fixed-precision string (default 2 decimals) */
export function decFixed(value: Decimal | number, places: number = 2): string {
  return toDecimal(value).toFixed(places);
}

/** Serialize Decimal to a fixed-precision string for API boundaries */
export function toDecimalString(
  value: Decimal | number | string | null | undefined,
  places: number = MONEY_SCALE,
): string | null {
  if (value === null || value === undefined) return null;
  return toDecimal(value).toFixed(places);
}

export type MoneyInput = Decimal | number | string | { toString(): string } | null | undefined;

/**
 * Canonical required money field: always an 8-dp decimal string.
 * Use at HTTP/WebSocket boundaries. Never return a JSON number.
 */
export function serializeMoney(value: MoneyInput): string {
  if (value === null || value === undefined || value === "") {
    return ZERO_MONEY;
  }
  return toDecimal(value).toFixed(MONEY_SCALE);
}

/** Canonical optional money field (payouts, end prices). */
export function serializeNullableMoney(value: MoneyInput): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return toDecimal(value).toFixed(MONEY_SCALE);
}
