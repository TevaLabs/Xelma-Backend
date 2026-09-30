import { z } from "zod";
import {
  RoundPriceRange,
  UserPriceRange,
  isUserPriceRange,
  isRoundPriceRangeArray,
} from "../types/round.types";

export const roundPriceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
  pool: z.number().default(0),
}).refine((data) => data.min < data.max, {
  message: "min must be less than max",
});

export const userPriceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
}).refine((data) => data.min < data.max, {
  message: "min must be less than max",
});

export function parseRoundPriceRanges(
  value: unknown,
): RoundPriceRange[] {
  if (isRoundPriceRangeArray(value)) {
    return value;
  }
  throw new Error("Invalid round price ranges: expected RoundPriceRange[]");
}

export function parseUserPriceRange(
  value: unknown,
): UserPriceRange {
  if (isUserPriceRange(value)) {
    return value;
  }
  throw new Error("Invalid user price range: expected UserPriceRange");
}

export function validateUserPriceRange(
  value: unknown,
): { valid: true; data: UserPriceRange } | { valid: false; error: string } {
  const result = userPriceRangeSchema.safeParse(value);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return { valid: false, error: result.error.message };
}

export function validateRoundPriceRanges(
  value: unknown,
): { valid: true; data: RoundPriceRange[] } | { valid: false; error: string } {
  const result = z.array(roundPriceRangeSchema).safeParse(value);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return { valid: false, error: result.error.message };
}

export function serializeRoundPriceRanges(
  ranges: RoundPriceRange[],
): RoundPriceRange[] {
  return ranges.map((r) => ({
    min: r.min,
    max: r.max,
    pool: r.pool,
  }));
}

export function createUserPriceRange(min: number, max: number): UserPriceRange {
  const validation = validateUserPriceRange({ min, max });
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  return validation.data;
}

export function createRoundPriceRange(
  min: number,
  max: number,
  pool: number = 0,
): RoundPriceRange {
  const result = roundPriceRangeSchema.safeParse({ min, max, pool });
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export function findRangeByBounds(
  ranges: RoundPriceRange[],
  min: number,
  max: number,
): RoundPriceRange | undefined {
  return ranges.find((r) => r.min === min && r.max === max);
}

export function updateRangePool(
  ranges: RoundPriceRange[],
  min: number,
  max: number,
  amountToAdd: number,
): RoundPriceRange[] {
  return ranges.map((r) => {
    if (r.min === min && r.max === max) {
      return { ...r, pool: r.pool + amountToAdd };
    }
    return r;
  });
}
