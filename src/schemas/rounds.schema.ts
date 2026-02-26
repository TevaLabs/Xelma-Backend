import { z } from 'zod';

export const startRoundSchema = z.object({
  mode: z
    .number()
    .int('Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)')
    .min(0, 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)')
    .max(1, 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)'),
  startPrice: z
    .number()
    .positive('Invalid start price'),
  duration: z
    .number()
    .positive('Invalid duration'),
});

export const resolveRoundSchema = z.object({
  finalPrice: z
    .number()
    .positive('Invalid final price'),
});
