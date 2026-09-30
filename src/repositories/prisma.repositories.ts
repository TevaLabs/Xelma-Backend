import { PlatformStats } from "../services/stats.service";
import {
  LeaderboardRepository,
  Repositories,
  RoundRepository,
  StatsRepository,
} from "./interfaces";

export class PrismaRoundRepository implements RoundRepository {
  async placeBet(
    roundId: string,
    address: string,
    amount: number,
    side?: "UP" | "DOWN",
    predictedPrice?: number,
  ): Promise<void> {
    const { default: hackathonService } =
      await import("../services/hackathon.service");
    await hackathonService.placeBet(
      roundId,
      address,
      amount,
      side,
      predictedPrice,
    );
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

  // `invalidateStatsCache` is synchronous (it clears a module-level cache
  // holder). Declaring this `async` made it a silently-floating promise that
  // resolved a microtask later than the caller assumed, so a write followed
  // by a read could still serve the stale value. Keep it sync.
  invalidateStatsCache(): void {
    const { invalidateStatsCache } = require("../services/stats.service");
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
