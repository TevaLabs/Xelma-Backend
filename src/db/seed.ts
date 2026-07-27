import { db, pool } from './db';
import { hackathonUsers, hackathonRounds } from './schema';

const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

const seedRounds = [
  {
    id: 'btc-updown-live',
    asset: 'BTC',
    mode: 'updown' as const,
    status: 'live' as const,
    startPrice: 67420,
    poolUp: 2800,
    poolDown: 1400,
    closesAt: minutesFromNow(3),
  },
  {
    id: 'eth-precision-live',
    asset: 'ETH',
    mode: 'precision' as const,
    status: 'live' as const,
    startPrice: 3241,
    totalPool: 1800,
    predictionCount: 22,
    closesAt: minutesFromNow(12),
  },
  {
    id: 'xlm-updown-new',
    asset: 'XLM',
    mode: 'updown' as const,
    status: 'new' as const,
    startPrice: 0.2891,
    poolUp: 200,
    poolDown: 0,
    closesAt: minutesFromNow(20),
  },
];

const seedUsers = [
  {
    address: 'GBZX...9QRA',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 42,
    totalLosses: 8,
    currentStreak: 9,
    xp: 18400,
    rankTitle: 'Oracle',
  },
  {
    address: 'GDK4...2LXM',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 37,
    totalLosses: 10,
    currentStreak: 6,
    xp: 15950,
    rankTitle: 'Market Sage',
  },
  {
    address: 'GAV7...8PQN',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 35,
    totalLosses: 13,
    currentStreak: 4,
    xp: 14820,
    rankTitle: 'Trend Master',
  },
  {
    address: 'GC9M...5VTE',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 31,
    totalLosses: 14,
    currentStreak: 3,
    xp: 13210,
    rankTitle: 'Signal Hunter',
  },
  {
    address: 'GCB2...7KDW',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 29,
    totalLosses: 15,
    currentStreak: 5,
    xp: 12490,
    rankTitle: 'Pool Climber',
  },
  {
    address: 'GDPT...4NLA',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 26,
    totalLosses: 16,
    currentStreak: 2,
    xp: 11160,
    rankTitle: 'Price Reader',
  },
  {
    address: 'GB7N...6XHF',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 24,
    totalLosses: 18,
    currentStreak: 1,
    xp: 10240,
    rankTitle: 'Streak Keeper',
  },
  {
    address: 'GCR8...3MLB',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 22,
    totalLosses: 20,
    currentStreak: 2,
    xp: 9480,
    rankTitle: 'Chart Scout',
  },
  {
    address: 'GAF5...1ZQH',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 19,
    totalLosses: 17,
    currentStreak: 1,
    xp: 8360,
    rankTitle: 'Breakout Seeker',
  },
  {
    address: 'GDT6...8RCV',
    balance: 1000,
    pendingWinnings: 0,
    totalWins: 17,
    totalLosses: 19,
    currentStreak: 0,
    xp: 7540,
    rankTitle: 'Rookie Prophet',
  },
];

async function main() {
  console.log('Seeding hackathon data (idempotent upserts)...');

  for (const round of seedRounds) {
    await db
      .insert(hackathonRounds)
      .values(round)
      .onConflictDoUpdate({
        target: hackathonRounds.id,
        set: {
          asset: round.asset,
          mode: round.mode,
          status: round.status,
          startPrice: round.startPrice,
          poolUp: round.poolUp ?? 0,
          poolDown: round.poolDown ?? 0,
          totalPool: round.totalPool ?? 0,
          predictionCount: round.predictionCount ?? 0,
          closesAt: round.closesAt,
        },
      });
  }

  for (const user of seedUsers) {
    await db
      .insert(hackathonUsers)
      .values(user)
      .onConflictDoUpdate({
        target: hackathonUsers.address,
        set: {
          balance: user.balance,
          pendingWinnings: user.pendingWinnings,
          totalWins: user.totalWins,
          totalLosses: user.totalLosses,
          currentStreak: user.currentStreak,
          xp: user.xp,
          rankTitle: user.rankTitle,
        },
      });
  }

  console.log('Seeding completed successfully!');
  await pool.end();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
