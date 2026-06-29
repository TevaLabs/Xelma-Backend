import { mockDataRepository } from '../repositories/mockData.repository';

// Keep the types for backward compatibility, although they can map directly to Prisma types
export type MockPredictionRound =
  | { id: string; asset: string; mode: 'updown'; status: 'live' | 'new'; startPrice: number; poolUp: number; poolDown: number; closesAt: string; }
  | { id: string; asset: string; mode: 'precision'; status: 'live' | 'new'; startPrice: number; totalPool: number; predictionCount: number; closesAt: string; };

export type MockLeaderboardUser = {
  rank: number;
  address: string;
  totalWins: number;
  totalLosses: number;
  winStreak: number;
  xp: number;
  rankTitle: string;
};

export const mockLeaderboard: MockLeaderboardUser[] = [
  { rank: 1, address: 'GBZX...9QRA', totalWins: 42, totalLosses: 8, winStreak: 9, xp: 18400, rankTitle: 'Oracle' },
  { rank: 2, address: 'GDK4...2LXM', totalWins: 37, totalLosses: 10, winStreak: 6, xp: 15950, rankTitle: 'Market Sage' },
  { rank: 3, address: 'GAV7...8PQN', totalWins: 35, totalLosses: 13, winStreak: 4, xp: 14820, rankTitle: 'Trend Master' },
  { rank: 4, address: 'GC9M...5VTE', totalWins: 31, totalLosses: 14, winStreak: 3, xp: 13210, rankTitle: 'Signal Hunter' },
  { rank: 5, address: 'GCB2...7KDW', totalWins: 29, totalLosses: 15, winStreak: 5, xp: 12490, rankTitle: 'Pool Climber' },
  { rank: 6, address: 'GDPT...4NLA', totalWins: 26, totalLosses: 16, winStreak: 2, xp: 11160, rankTitle: 'Price Reader' },
  { rank: 7, address: 'GB7N...6XHF', totalWins: 24, totalLosses: 18, winStreak: 1, xp: 10240, rankTitle: 'Streak Keeper' },
  { rank: 8, address: 'GCR8...3MLB', totalWins: 22, totalLosses: 20, winStreak: 2, xp: 9480, rankTitle: 'Chart Scout' },
  { rank: 9, address: 'GAF5...1ZQH', totalWins: 19, totalLosses: 17, winStreak: 1, xp: 8360, rankTitle: 'Breakout Seeker' },
  { rank: 10, address: 'GDT6...8RCV', totalWins: 17, totalLosses: 19, winStreak: 0, xp: 7540, rankTitle: 'Rookie Prophet' },
];

// Async functions calling the new Prisma repository
export const getMockRounds = async (): Promise<MockPredictionRound[]> => {
  const rounds = await mockDataRepository.getRounds();
  // Map Prisma models back to the expected union type
  return rounds.map(r => {
    if (r.mode === 'updown') {
      return {
        id: r.id, asset: r.asset, mode: 'updown', status: r.status as 'live' | 'new',
        startPrice: r.startPrice, poolUp: r.poolUp!, poolDown: r.poolDown!, closesAt: r.closesAt
      };
    }
    return {
      id: r.id, asset: r.asset, mode: 'precision', status: r.status as 'live' | 'new',
      startPrice: r.startPrice, totalPool: r.totalPool!, predictionCount: r.predictionCount!, closesAt: r.closesAt
    };
  });
};

export const getMockLeaderboard = async (): Promise<MockLeaderboardUser[]> => {
  return mockDataRepository.getLeaderboard();
};

export const getMockData = async () => {
  const platformStats = await mockDataRepository.getPlatformStats();
  const leaderboard = await getMockLeaderboard();

  return {
    prices: mockData.prices,
    platformStats: platformStats ? {
      totalRounds: platformStats.totalRounds,
      totalVxlmDistributed: platformStats.totalVxlmDistributed,
      activePlayers: platformStats.activePlayers,
      totalBetsPlaced: platformStats.totalBetsPlaced,
    } : {
      totalRounds: 1247,
      totalVxlmDistributed: 4200000,
      activePlayers: 893,
      totalBetsPlaced: 8432,
    },
    leaderboard,
  };
};

// Synchronous prices array remains in memory because price polling relies on it synchronously if DB fallback is invoked
export const mockData = {
  prices: [
    { id: 'bitcoin', symbol: 'btc', price: 60000 },
    { id: 'ethereum', symbol: 'eth', price: 3000 },
  ],
};

/**
 * Static mock constants used as a fallback by the stats service when the
 * database is empty or unreachable.
 */
export const MOCK_PLATFORM_STATS = {
  totalRounds: 0,
  totalUsers: 0,
  totalBets: 0,
} as const;