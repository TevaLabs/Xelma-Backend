import { z } from "zod";
import { offsetPaginationSchema } from "./pagination.schema";

export const joinTournamentParamsSchema = z.object({
  id: z.string().min(1, "Tournament ID is required"),
});

export type JoinTournamentParams = z.infer<typeof joinTournamentParamsSchema>;

export const tournamentModeSchema = z.enum(["UP_DOWN", "LEGENDS"]);
export const tournamentStatusSchema = z.enum([
  "UPCOMING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * Query params for GET /api/tournaments.
 * Supports mode and/or status filters with shared offset pagination.
 */
export const tournamentListQuerySchema = offsetPaginationSchema.extend({
  mode: tournamentModeSchema.optional(),
  status: tournamentStatusSchema.optional(),
});

export type TournamentListQuery = z.infer<typeof tournamentListQuerySchema>;

/**
 * Body for POST /api/tournaments (admin creates a tournament).
 *
 * Money fields arrive as strings on the wire (JSON has no decimal type) but
 * numbers are tolerated for ergonomics; the service converts via `toDecimal`.
 * Times arrive as ISO strings and are coerced to `Date` so the service's
 * ordering check does not crash on raw strings.
 */
export const tournamentCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    mode: tournamentModeSchema,
    entryFee: z.union([z.string(), z.number()]),
    prizePool: z.union([z.string(), z.number()]),
    maxParticipants: z.number().int().min(1),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    rounds: z.number().int().min(1),
  })
  .strict();

export type TournamentCreateInput = z.infer<typeof tournamentCreateSchema>;
