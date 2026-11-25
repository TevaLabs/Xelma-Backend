import { z } from "zod";
import { offsetPaginationSchema } from "./pagination.schema";

export const joinTournamentParamsSchema = z.object({
  id: z.string().min(1, "Tournament ID is required"),
});

export type JoinTournamentParams = z.infer<typeof joinTournamentParamsSchema>;

export const tournamentModeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toUpperCase() : value),
  z.enum(["UP_DOWN", "LEGENDS"]),
);

export const tournamentStatusSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toUpperCase() : value),
  z.enum(["UPCOMING", "ACTIVE", "COMPLETED", "CANCELLED"]),
);

/**
 * Query params for GET /api/tournaments.
 * Supports mode and/or status filters with shared offset pagination.
 *
 * The mode and status filters are case-insensitive (`?status=active` works)
 * and are normalised to their canonical upper-case form, so the service layer
 * only ever sees the persisted enum values.
 */
export const tournamentListQuerySchema = offsetPaginationSchema.extend({
  mode: tournamentModeSchema.optional(),
  status: tournamentStatusSchema.optional(),
});

export type TournamentListQuery = z.infer<typeof tournamentListQuerySchema>;
