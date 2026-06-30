import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

const mockRounds = [
  {
    id: 'btc-updown-live',
    asset: 'BTC',
    mode: 'updown',
    status: 'live',
    startPrice: 67420,
    poolUp: 2800,
    poolDown: 1400,
    totalPool: null,
    predictionCount: null,
    closesAt: minutesFromNow(3),
  },
  {
    id: 'eth-precision-live',
    asset: 'ETH',
    mode: 'precision',
    status: 'live',
    startPrice: 3241,
    poolUp: null,
    poolDown: null,
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
    totalPool: null,
    predictionCount: null,
    closesAt: minutesFromNow(20),
  },
];

const mockLeaderboard = [
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

const mockPlatformStats = {
  id: 1,
  totalRounds: 1247,
  totalVxlmDistributed: 4200000,
  activePlayers: 893,
  totalBetsPlaced: 8432,
};

async function main() {
  console.log('Seeding mock data...');

  // Upsert Platform Stats
  await prisma.mockPlatformStat.upsert({
    where: { id: 1 },
    update: mockPlatformStats,
    create: mockPlatformStats,
  });

  // Upsert Leaderboard
  for (const user of mockLeaderboard) {
    await prisma.mockLeaderboard.upsert({
      where: { address: user.address },
      update: user,
      create: user,
    });
  }

  // Upsert Rounds
  for (const round of mockRounds) {
    await prisma.mockRound.upsert({
      where: { id: round.id },
      update: round,
      create: round,
    });
  }

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
