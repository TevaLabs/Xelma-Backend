import { z } from "zod";
import { stellarAddressSchema } from "../utils/stellar-address.util";
import { precisionPriceSchema, stakeAmountSchema } from "../utils/max-stake.util";

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
  predictedPrice: precisionPriceSchema(),
});

/** Claim body: address is bound from JWT via bindAuthenticatedWallet before validate. */
export const claimWinningsSchema = z.object({
  address: stellarAddressSchema,
});

export const betSchema = z.union([upDownBetSchema, precisionBetSchema]);
