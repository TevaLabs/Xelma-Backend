import { z } from "zod";
import { stellarAddressSchema } from "../utils/stellar-address.util";
import { stakeAmountSchema } from "../utils/max-stake.util";

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
  predictedPrice: z
    .number({ message: "predictedPrice is required" })
    .positive("predictedPrice must be a positive number"),
});

/** Claim body: address is bound from JWT via bindAuthenticatedWallet before validate. */
export const claimWinningsSchema = z.object({
  address: stellarAddressSchema,
});

export const betSchema = z.union([upDownBetSchema, precisionBetSchema]);
