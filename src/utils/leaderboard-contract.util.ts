import { LeaderboardContract, LeaderboardEntry } from "../types/leaderboard.types";
import type { LeaderboardListResponse } from "../repositories/interfaces";

interface MockLeaderboardEntry {
  rank: number;
  address: string;
  totalWins: number;
  totalLosses: number;
  winStreak: number;
  xp: number;
  rankTitle: string;
}

function toMockEntry(entry: MockLeaderboardEntry, index: number): LeaderboardEntry {
  const totalPredictions = entry.totalWins + entry.totalLosses;
  const accuracy = totalPredictions === 0
    ? 0
    : Math.round((entry.totalWins / totalPredictions) * 100 * 100) / 100;

  return {
    rank: index + 1,
    userId: entry.address,
    walletAddress: entry.address,
    totalEarnings: entry.xp.toFixed(8),
    totalPredictions,
    accuracy,
    modeStats: {
      upDown: {
        wins: entry.totalWins,
        losses: entry.totalLosses,
        earnings: entry.xp.toFixed(8),
        accuracy,
      },
      legends: {
        wins: 0,
        losses: 0,
        earnings: "0.00000000",
        accuracy: 0,
      },
    },
  };
}

export function toLeaderboardContract(
  result: LeaderboardListResponse,
  limit: number,
  offset: number,
): LeaderboardContract {
  if (!Array.isArray(result)) {
    return {
      ...result,
      pagination: result.pagination ?? {
        limit,
        offset,
        total: result.totalUsers,
        hasNextPage: false,
      },
    };
  }

  const leaderboard = result.map((entry, index) => toMockEntry(entry, index));
  return {
    leaderboard,
    totalUsers: leaderboard.length,
    lastUpdated: new Date().toISOString(),
    pagination: {
      limit,
      offset,
      total: leaderboard.length,
      hasNextPage: false,
    },
  };
}
