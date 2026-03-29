import { z } from 'zod';

const predictionPriceRangeSchema = z.object({
  min: z.number().finite('priceRange.min must be a finite number'),
  max: z.number().finite('priceRange.max must be a finite number'),
}).refine((range) => range.min < range.max, {
  message: 'priceRange must satisfy min < max',
});

export const submitPredictionSchema = z.object({
  roundId: z
    .string()
    .min(1, 'Round ID is required'),
  amount: z
    .number()
    .positive('Invalid amount'),
  side: z.string().optional(),
  priceRange: predictionPriceRangeSchema.optional(),
}).refine(
  (data) => data.side || data.priceRange,
  { message: 'Either side (UP/DOWN) or priceRange must be provided' },
);
