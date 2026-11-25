import { z } from "zod";
import { MONEY_SCALE, toDecimal } from "./decimal.util";

/** Default cap, in XLM (the same unit as every `amount` field in the API). */
export const DEFAULT_MAX_STAKE = 1_000_000;

/**
 * Resolve the per-bet / per-prediction cap in XLM.
 * Read lazily so the env var can change between requests/tests.
 * Falls back to the default when unset or not a positive finite number.
 */
export function getMaxStake(): number {
  const raw = process.env.MAX_STAKE ?? process.env.MAX_PREDICTION_AMOUNT;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STAKE;
}

/** Prisma stores money as Decimal(20, 8), so inputs may use at most 8 dp. */
function fitsMoneyScale(value: number): boolean {
  return toDecimal(value).decimalPlaces() <= MONEY_SCALE;
}

/** Positive, finite amount in XLM that does not exceed the configured cap. */
export function stakeAmountSchema(requiredMessage = "amount is required", invalidMessage = "amount must be a positive number") {
  return z
    .number({ message: requiredMessage })
    .positive(invalidMessage)
    .refine((value) => value <= getMaxStake(), {
      message: `amount must not exceed the maximum stake of ${getMaxStake()} XLM`,
    })
    .refine(fitsMoneyScale, {
      message: `amount must have at most ${MONEY_SCALE} decimal places`,
    });
}

/**
 * Precision bet price. Uses the same cap and Decimal(20, 8) scale as stake
 * amounts so an accepted request cannot be rejected later when it is stored.
 */
export function precisionPriceSchema() {
  return z
    .number({ message: "predictedPrice is required" })
    .positive("predictedPrice must be a positive number")
    .refine((value) => value <= getMaxStake(), {
      message: `predictedPrice must not exceed the maximum of ${getMaxStake()} XLM`,
    })
    .refine(fitsMoneyScale, {
      message: `predictedPrice must have at most ${MONEY_SCALE} decimal places`,
    });
}
