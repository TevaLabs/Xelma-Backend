import { z } from "zod";
import { offsetPaginationSchema } from "./pagination.schema";

export const joinTournamentParamsSchema = z.object({
  id: z.string().min(1, "Tournament ID is required"),
});

export type JoinTournamentParams = z.infer<typeof joinTournamentParamsSchema>;

export const tournamentListQuerySchema = offsetPaginationSchema.extend({
  status: z.enum(["UPCOMING", "ACTIVE", "COMPLETED"]).optional(),
  mode: z.enum(["UP_DOWN", "LEGENDS"]).optional(),
});

export type TournamentListQuery = z.infer<typeof tournamentListQuerySchema>;
