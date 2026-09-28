import { z } from 'zod';
import { stakeAmountSchema } from '../utils/max-stake.util';

export const priceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
  pool: z.number().optional().default(0),
}).refine((data) => data.min < data.max, {
  message: "min must be less than max",
});

export const userPriceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
}).refine((data) => data.min < data.max, {
  message: "min must be less than max",
});

const priceStringOrNumber = z.union([
  z.number(),
  z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'Invalid price format'),
]);

export const startRoundSchema = z.object({
  mode: z
    .number()
    .int('Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)')
    .min(0, 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)')
    .max(1, 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)'),
  startPrice: priceStringOrNumber.refine((value) => {
    const numeric = typeof value === 'string' ? parseFloat(value) : value;
    return Number.isFinite(numeric) && numeric > 0;
  }, 'Invalid start price'),
  duration: z
    .number()
    .positive('Invalid duration'),
  priceRanges: z.array(priceRangeSchema).min(2, 'LEGENDS mode requires at least 2 ranges').optional(),
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
  finalPrice: priceStringOrNumber.refine((value) => {
    const numeric = typeof value === 'string' ? parseFloat(value) : value;
    return Number.isFinite(numeric) && numeric > 0;
  }, 'Invalid final price'),
});

/**
 * Body contract for the QA-only `POST /api/rounds/:id/simulate` endpoint (#667).
 *
 * Same `finalPrice` shape as {@link resolveRoundSchema} — a positive price,
 * accepted as either a JSON number or a numeric string, exactly like the real
 * settlement path it stands in for.
 *
 * `finalPrice` is declared optional and then required by a presence refine
 * rather than as a plain required key: that way a missing field produces
 * "finalPrice is required" instead of Zod's generic "Invalid input". The
 * simulate endpoint is a manual QA tool, so the operator hitting it should get
 * a message that names the field.
 */
export const simulateRoundSchema = z
  .object({
    finalPrice: priceStringOrNumber
      .refine((value) => {
        const numeric = typeof value === 'string' ? parseFloat(value) : value;
        return Number.isFinite(numeric) && numeric > 0;
      }, 'finalPrice must be a positive number')
      .optional(),
  })
  .refine((data) => data.finalPrice !== undefined, {
    message: 'finalPrice is required',
    path: ['finalPrice'],
  });

export const createPriceRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
});

export const submitLegendsPredictionSchema = z.object({
  roundId: z.string().uuid(),
  amount: stakeAmountSchema(),
  priceRange: userPriceRangeSchema,
});
