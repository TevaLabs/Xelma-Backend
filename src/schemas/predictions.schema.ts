import { z } from 'zod';

export const submitPredictionSchema = z.object({
  roundId: z
    .string()
    .min(1, 'Round ID is required'),
  amount: z
    .number()
    .positive('Invalid amount'),
  side: z.string().optional(),
  priceRange: z.any().optional(),
}).refine(
  (data) => data.side || data.priceRange,
  { message: 'Either side (UP/DOWN) or priceRange must be provided' },
);
