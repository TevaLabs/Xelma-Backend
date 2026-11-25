import { z } from 'zod';

/**
 * Declarative eligibility rule for a tip. The catalog lives in JSON, so a
 * condition is data the service evaluates against the round's TipContext
 * rather than a function.
 */
export const tipConditionSchema = z.discriminatedUnion('type', [
  // Eligible when the round was classified as high volatility.
  z.strictObject({ type: z.literal('highVolatility') }),
  // Eligible when |priceChangePercent| is strictly above `gt` and/or below `lt`.
  z
    .strictObject({
      type: z.literal('absPriceChangePercent'),
      gt: z.number().nonnegative().optional(),
      lt: z.number().positive().optional(),
    })
    .refine((c) => c.gt !== undefined || c.lt !== undefined, {
      message: 'absPriceChangePercent condition needs at least one of `gt` or `lt`',
    }),
]);

export const tipTemplateSchema = z.strictObject({
  id: z.string().min(1, 'Tip id is required'),
  category: z.enum(['volatility', 'oracle', 'stellar', 'price-action']),
  // Message template; supports {variable} placeholders interpolated by the service.
  message: z.string().min(1, 'Tip message is required'),
  // Selection weight. Higher = more likely to be selected.
  priority: z.number().positive().optional(),
  condition: tipConditionSchema.optional(),
});

export const tipCatalogSchema = z
  .array(tipTemplateSchema)
  .min(1, 'Tip catalog must contain at least one tip')
  .superRefine((tips, ctx) => {
    const seen = new Set<string>();
    tips.forEach((tip, index) => {
      if (seen.has(tip.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate tip id "${tip.id}"`,
          path: [index, 'id'],
        });
      }
      seen.add(tip.id);
    });
  });

export type TipCondition = z.infer<typeof tipConditionSchema>;
export type TipTemplate = z.infer<typeof tipTemplateSchema>;

/**
 * Validate raw catalog content (the parsed src/data/education-tips.json).
 * Throws with every offending path listed so a bad edit to the JSON is
 * actionable from the startup log alone.
 */
export function parseTipCatalog(raw: unknown): TipTemplate[] {
  const result = tipCatalogSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid education tip catalog (src/data/education-tips.json):\n${problems}`,
    );
  }
  return result.data;
}
