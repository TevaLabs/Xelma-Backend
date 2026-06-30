import { PlatformStats } from "../services/stats.service";
import {
  LeaderboardRepository,
  Repositories,
  RoundRepository,
  StatsRepository,
} from "./interfaces";

export class PrismaRoundRepository implements RoundRepository {
  async listActiveRounds() {
    const { default: roundService } = await import("../services/round.service");
    const { rounds, source } = await roundService.getRoundsForApi();
    return { source, rounds };
  }

  async placeBet(roundId: string, address: string, amount: number, side?: "UP" | "DOWN", predictedPrice?: number): Promise<void> {
    const { default: hackathonService } = await import("../services/hackathon.service");
    await hackathonService.placeBet(roundId, address, amount, side, predictedPrice);
  }
}

export class PrismaLeaderboardRepository implements LeaderboardRepository {
  async listLeaderboard(limit = 100, offset = 0, userId?: string) {
    const { getLeaderboard } = await import("../services/leaderboard.service");
    return getLeaderboard(limit, offset, userId);
  }
}

export class PrismaStatsRepository implements StatsRepository {
  async getPlatformStats(): Promise<PlatformStats> {
    const { getPlatformStats } = await import("../services/stats.service");
    return getPlatformStats();
  }

  async invalidateStatsCache(): Promise<void> {
    const { invalidateStatsCache } = await import("../services/stats.service");
    invalidateStatsCache();
  }
}

export function createPrismaRepositories(): Repositories {
  return {
    rounds: new PrismaRoundRepository(),
    leaderboard: new PrismaLeaderboardRepository(),
    stats: new PrismaStatsRepository(),
  };
}
