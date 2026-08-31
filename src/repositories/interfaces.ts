import { MockLeaderboardUser } from "../data/mockData";
import { PlatformStats } from "../services/stats.service";
import { LeaderboardResponse } from "../types/leaderboard.types";

export interface RoundListItem {
  id: string;
  mode: string;
  status: string;
  startPrice: string | number;
  source: "soroban" | "database" | "mock";
}

export type LeaderboardListResponse =
  | MockLeaderboardUser[]
  | LeaderboardResponse;

export interface RoundRepository {
  placeBet(
    roundId: string,
    address: string,
    amount: number,
    side?: "UP" | "DOWN",
    predictedPrice?: number,
  ): Promise<void>;
}

export interface LeaderboardRepository {
  listLeaderboard(
    limit?: number,
    offset?: number,
    userId?: string,
  ): Promise<LeaderboardListResponse>;
}

export interface StatsRepository {
  getPlatformStats(): Promise<PlatformStats>;
  invalidateStatsCache(): void;
}

export interface Repositories {
  rounds: RoundRepository;
  leaderboard: LeaderboardRepository;
  stats: StatsRepository;
}
