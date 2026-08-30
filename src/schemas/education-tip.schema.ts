import { z } from "zod";

export const tipConditionSchema = z.object({
  type: z.enum([
    "highVolatility",
    "priceChangeGreaterThan",
    "priceChangeLessThan",
  ]),
  value: z.number().optional(),
});

export const tipTemplateSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["volatility", "oracle", "stellar", "price-action"]),
  message: z.string().min(1),
  priority: z.number().int().min(0).default(50),
  condition: tipConditionSchema.optional(),
});

export const tipLibrarySchema = z.array(tipTemplateSchema);

export type TipConditionData = z.infer<typeof tipConditionSchema>;
export type TipTemplateData = z.infer<typeof tipTemplateSchema>;
