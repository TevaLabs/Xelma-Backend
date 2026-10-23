import { z } from "zod";
import { stellarAddressSchema } from "../utils/stellar-address.util";
import { stakeAmountSchema } from "../utils/max-stake.util";
import { DECIMAL_18_8_MAX, MONEY_SCALE, fitsDecimalPlaces } from "../utils/decimal.util";

/**
 * Both `Bet.amount` and `Bet.predictedPrice` are `Decimal(18, 8)`. Anything
 * with more than 8 decimal places or above the column maximum would be
 * silently rounded/truncated by PostgreSQL, so reject it at the API boundary.
 * (Available balance is still checked inside the placement transaction; it is
 * not knowable from the request body.)
 */
export function decimal18_8Schema(label: string) {
  return z
    .number({ message: `${label} is required` })
    .finite(`${label} must be a finite number`)
    .refine((value) => fitsDecimalPlaces(value, MONEY_SCALE), {
      message: `${label} must have at most ${MONEY_SCALE} decimal places`,
    })
    .refine((value) => value <= Number(DECIMAL_18_8_MAX), {
      message: `${label} must not exceed ${DECIMAL_18_8_MAX}`,
    });
}

export const upDownBetSchema = z.object({
  address: stellarAddressSchema,
  amount: stakeAmountSchema(),
  side: z.enum(["UP", "DOWN"], {
    message: "side must be UP or DOWN",
  }),
});

export const precisionBetSchema = z.object({
  address: stellarAddressSchema,
  amount: stakeAmountSchema(),
  predictedPrice: decimal18_8Schema("predictedPrice")
    .refine((value) => value > 0, "predictedPrice must be a positive number"),
});

/** Claim body: address is bound from JWT via bindAuthenticatedWallet before validate. */
export const claimWinningsSchema = z.object({
  address: stellarAddressSchema,
});

export const betSchema = z.union([upDownBetSchema, precisionBetSchema]);
