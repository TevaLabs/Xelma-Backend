import { z } from "zod";
import { offsetPaginationSchema } from "./pagination.schema";

export const joinTournamentParamsSchema = z.object({
  id: z.string().min(1, "Tournament ID is required"),
});

export type JoinTournamentParams = z.infer<typeof joinTournamentParamsSchema>;

export const tournamentListQuerySchema = offsetPaginationSchema.extend({
  status: z.string().optional(),
});

export type TournamentListQuery = z.infer<typeof tournamentListQuerySchema>;
