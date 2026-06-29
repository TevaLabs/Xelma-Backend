import { betStore, StoredRound } from "../data/bet-store";
import { mockLeaderboard, MOCK_PLATFORM_STATS } from "../data/mockData";
import {
  LeaderboardRepository,
  Repositories,
  RoundRepository,
  StatsRepository,
} from "./interfaces";
import { PlatformStats } from "../services/stats.service";

function storedRoundToMockPredictionRound(r: StoredRound) {
  if (r.mode === 'updown') {
    return {
      id: r.id, asset: r.asset, mode: 'updown' as const, status: r.status as 'live' | 'new',
      startPrice: r.startPrice, poolUp: r.poolUp, poolDown: r.poolDown, closesAt: r.closesAt,
    };
  }
  return {
    id: r.id, asset: r.asset, mode: 'precision' as const, status: r.status as 'live' | 'new',
    startPrice: r.startPrice, totalPool: r.totalPool, predictionCount: r.predictionCount, closesAt: r.closesAt,
  };
}

export class InMemoryRoundRepository implements RoundRepository {
  async listActiveRounds() {
    return betStore.getRounds().map(storedRoundToMockPredictionRound);
  }

  async placeBet(roundId: string, _address: string, amount: number, side?: "UP" | "DOWN", predictedPrice?: number): Promise<void> {
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
