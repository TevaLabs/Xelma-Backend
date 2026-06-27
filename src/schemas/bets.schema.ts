import { z } from "zod";
import { isValidStellarAddress } from "../services/stellar.service";

const stellarAddressSchema = z
  .string({ error: "address is required" })
  .min(1, "address is required")
  .refine(isValidStellarAddress, "Invalid Stellar wallet address format");

const optionalStellarAddressSchema = stellarAddressSchema.optional();

export const upDownBetSchema = z.object({
  address: stellarAddressSchema,
  amount: z.number({ message: "amount is required" }).positive("amount must be a positive number"),
  side: z.enum(["UP", "DOWN"], {
    message: "side must be UP or DOWN",
  }),
});

export const precisionBetSchema = z.object({
  address: stellarAddressSchema,
  amount: z.number({ message: "amount is required" }).positive("amount must be a positive number"),
  predictedPrice: z
    .number({ message: "predictedPrice is required" })
    .positive("predictedPrice must be a positive number"),
});
