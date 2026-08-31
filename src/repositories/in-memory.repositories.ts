import { betStore } from "../data/bet-store";
import { mockLeaderboard, MOCK_PLATFORM_STATS } from "../data/mockData";
import {
  LeaderboardRepository,
  Repositories,
  RoundRepository,
  StatsRepository,
} from "./interfaces";
import { PlatformStats } from "../services/stats.service";


export class InMemoryRoundRepository implements RoundRepository {
  async placeBet(
    roundId: string,
    _address: string,
    amount: number,
    side?: "UP" | "DOWN",
    predictedPrice?: number,
  ): Promise<void> {
    if (side) {
      betStore.addUpDownBet(roundId, _address, amount, side);
    } else if (predictedPrice !== undefined) {
      betStore.addPrecisionBet(roundId, _address, amount, predictedPrice);
    }
  }
}

export class InMemoryLeaderboardRepository implements LeaderboardRepository {
  async listLeaderboard(limit = 100, offset = 0) {
    return mockLeaderboard.slice(offset, offset + limit);
  }
}

export class InMemoryStatsRepository implements StatsRepository {
  private cachedStats: PlatformStats | null = null;

  async getPlatformStats(): Promise<PlatformStats> {
    if (!this.cachedStats) {
      this.cachedStats = {
        ...MOCK_PLATFORM_STATS,
        totalBets: betStore.getTotalBetsCount(),
        isFallback: true,
        cachedAt: new Date().toISOString(),
      };
    }
    return this.cachedStats;
  }

  invalidateStatsCache(): void {
    this.cachedStats = null;
  }
}

export function createInMemoryRepositories(): Repositories {
  return {
    rounds: new InMemoryRoundRepository(),
    leaderboard: new InMemoryLeaderboardRepository(),
    stats: new InMemoryStatsRepository(),
  };
}
