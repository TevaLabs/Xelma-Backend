import { z } from 'zod';

const legendsPriceRangeSchema = z.object({
  min: z.number().finite('Range min must be a finite number'),
  max: z.number().finite('Range max must be a finite number'),
}).refine((range) => range.min < range.max, {
  message: 'Each range must satisfy min < max',
});

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
  priceRanges: z.array(legendsPriceRangeSchema).min(2, 'LEGENDS mode requires at least 2 ranges').optional(),
}).superRefine((data, ctx) => {
  if (data.mode !== 1 && data.priceRanges) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'priceRanges is only supported when mode is LEGENDS (1)',
      path: ['priceRanges'],
    });
  }

  if (data.mode === 1 && data.priceRanges?.length) {
    const sorted = [...data.priceRanges].sort((a, b) => a.min - b.min);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].min < sorted[i - 1].max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'LEGENDS price ranges must not overlap',
          path: ['priceRanges', i],
        });
      }
    }
  }
});

export const resolveRoundSchema = z.object({
  finalPrice: z
    .number()
    .positive('Invalid final price'),
});
