// TODO: Replace with PostgreSQL database
export type MockPredictionRound =
  | {
    id: string;
    asset: string;
    mode: 'updown';
    status: 'live' | 'new';
    startPrice: number;
    poolUp: number;
    poolDown: number;
    closesAt: string;
  }
  | {
    id: string;
    asset: string;
    mode: 'precision';
    status: 'live' | 'new';
    startPrice: number;
    totalPool: number;
    predictionCount: number;
    closesAt: string;
  };

const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

// TODO: Replace with on-chain query via get_active_round() from Xelma contract
export const getMockRounds = (): MockPredictionRound[] => [
  {
    id: 'btc-updown-live',
    asset: 'BTC',
    mode: 'updown',
    status: 'live',
    startPrice: 67420,
    poolUp: 2800,
    poolDown: 1400,
    closesAt: minutesFromNow(3),
  },
  {
    id: 'eth-precision-live',
    asset: 'ETH',
    mode: 'precision',
    status: 'live',
    startPrice: 3241,
    totalPool: 1800,
    predictionCount: 22,
    closesAt: minutesFromNow(12),
  },
  {
    id: 'xlm-updown-new',
    asset: 'XLM',
    mode: 'updown',
    status: 'new',
    startPrice: 0.2891,
    poolUp: 200,
    poolDown: 0,
    closesAt: minutesFromNow(20),
  },
];

export type MockLeaderboardUser = {
  rank: number;
  address: string;
  totalWins: number;
  totalLosses: number;
  winStreak: number;
  xp: number;
  rankTitle: string;
};

// TODO: Query on-chain user stats via get_user_stats() for each known address
export const mockLeaderboard: MockLeaderboardUser[] = [
  {
    rank: 1,
    address: 'GBZX...9QRA',
    totalWins: 42,
    totalLosses: 8,
    winStreak: 9,
    xp: 18400,
    rankTitle: 'Oracle',
  },
  {
    rank: 2,
    address: 'GDK4...2LXM',
    totalWins: 37,
    totalLosses: 10,
    winStreak: 6,
    xp: 15950,
    rankTitle: 'Market Sage',
  },
  {
    rank: 3,
    address: 'GAV7...8PQN',
    totalWins: 35,
    totalLosses: 13,
    winStreak: 4,
    xp: 14820,
    rankTitle: 'Trend Master',
  },
  {
    rank: 4,
    address: 'GC9M...5VTE',
    totalWins: 31,
    totalLosses: 14,
    winStreak: 3,
    xp: 13210,
    rankTitle: 'Signal Hunter',
  },
  {
    rank: 5,
    address: 'GCB2...7KDW',
    totalWins: 29,
    totalLosses: 15,
    winStreak: 5,
    xp: 12490,
    rankTitle: 'Pool Climber',
  },
  {
    rank: 6,
    address: 'GDPT...4NLA',
    totalWins: 26,
    totalLosses: 16,
    winStreak: 2,
    xp: 11160,
    rankTitle: 'Price Reader',
  },
  {
    rank: 7,
    address: 'GB7N...6XHF',
    totalWins: 24,
    totalLosses: 18,
    winStreak: 1,
    xp: 10240,
    rankTitle: 'Streak Keeper',
  },
  {
    rank: 8,
    address: 'GCR8...3MLB',
    totalWins: 22,
    totalLosses: 20,
    winStreak: 2,
    xp: 9480,
    rankTitle: 'Chart Scout',
  },
  {
    rank: 9,
    address: 'GAF5...1ZQH',
    totalWins: 19,
    totalLosses: 17,
    winStreak: 1,
    xp: 8360,
    rankTitle: 'Breakout Seeker',
  },
  {
    rank: 10,
    address: 'GDT6...8RCV',
    totalWins: 17,
    totalLosses: 19,
    winStreak: 0,
    xp: 7540,
    rankTitle: 'Rookie Prophet',
  },
];

export const mockData = {
  prices: [
    { id: 'bitcoin', symbol: 'btc', price: 60000 },
    { id: 'ethereum', symbol: 'eth', price: 3000 },
  ],
  // TODO: Replace with live Stellar RPC queries via @stellar/stellar-sdk
  platformStats: {
    totalRounds: 1247,
    totalVxlmDistributed: 4200000,
    activePlayers: 893,
    totalBetsPlaced: 8432,
  },
  leaderboard: mockLeaderboard,
};

/**
 * Static mock constants used as a fallback by the stats service when the
 * database is empty or unreachable.
 *
 * FALLBACK MODE: when `GET /api/stats` returns `"isFallback": true`, the
 * numbers below are being served instead of live DB aggregates.  This happens
 * in two situations:
 *
 *   1. The data store is genuinely empty (no rounds, no users, no bets yet).
 *      Typical during local development before any gameplay has occurred.
 *
 *   2. The database connection failed at query time (misconfigured DATABASE_URL,
 *      network partition, migration not yet applied, etc.).
 *
 * Operators can tell which case they're in by checking server logs:
 *   - "DB query failed, using mock fallback" → case 2 (infra issue)
 *   - No such log line but isFallback=true → case 1 (empty store, expected)
 *
 * To stop seeing fallback mode, create at least one round, user, or prediction
 * in the database, or fix the DATABASE_URL / run `npm run db:prepare`.
 */
export const MOCK_PLATFORM_STATS = {
  totalRounds: 0,
  totalUsers: 0,
  totalBets: 0,
} as const;