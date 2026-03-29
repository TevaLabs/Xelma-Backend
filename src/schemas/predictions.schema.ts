import { z } from "zod";

export const submitPredictionSchema = z
  .object({
    roundId: z.string().min(1, "Round ID is required"),
    amount: z.number().positive("Invalid amount"),
    side: z.string().optional(),
    priceRange: z.any().optional(),
  })
  .refine((data) => data.side || data.priceRange, {
    message: "Either side (UP/DOWN) or priceRange must be provided",
  });

export const batchSubmitPredictionsSchema = z
  .object({
    predictions: z
      .array(submitPredictionSchema)
      .min(1, "At least one prediction is required")
      .max(50, "Maximum 50 predictions per batch"),
  })
  .refine(
    (data) => {
      const roundIds = data.predictions.map((p) => p.roundId);
      return new Set(roundIds).size === roundIds.length;
    },
    { message: "Duplicate round IDs are not allowed in a batch" },
  );

export const batchLeaderboardQuerySchema = z.object({
  userIds: z
    .array(z.string().min(1))
    .min(1, "At least one user ID is required")
    .max(100, "Maximum 100 user IDs per query"),
});
