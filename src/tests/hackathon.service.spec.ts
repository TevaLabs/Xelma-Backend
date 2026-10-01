import { describe, it, expect, beforeEach, jest } from '@jest/globals';

interface LeaderboardRow {
  address: string;
  balance: number;
  pendingWinnings: number;
  totalWins: number;
  totalLosses: number;
  winStreak: number;
  xp: number;
  rankTitle: string;
}

interface RoundRow {
  id: string;
  mode: 'updown' | 'precision';
  poolUp: number;
  poolDown: number;
  totalPool: number;
  predictionCount: number;
}

interface BetRow {
  roundId: string;
  address: string;
  amount: number;
  side?: 'UP' | 'DOWN';
  predictedPrice?: number;
}

let leaderboard: LeaderboardRow[];
let rounds: RoundRow[];
let bets: BetRow[];
let transactionCount: number;

jest.mock('../lib/prisma', () => {
  const { toDecimal, toNumber } = require('../utils/decimal.util');

  /**
   * Apply a Prisma update payload the way the database would: `{ increment }`
   * and `{ decrement }` are relative and evaluated with Decimal arithmetic,
   * anything else is a plain assignment.
   */
  const applyUpdate = (target: Record<string, any>, data: Record<string, any>) => {
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        target[field] = toNumber(toDecimal(target[field]).plus(toDecimal(value.increment)));
      } else if (value && typeof value === 'object' && 'decrement' in value) {
        target[field] = toNumber(toDecimal(target[field]).minus(toDecimal(value.decrement)));
      } else {
        target[field] = value;
      }
    }
    return target;
  };

  const delegates = {
    mockLeaderboard: {
      findUnique: async ({ where }: { where: { address: string } }) =>
        leaderboard.find(user => user.address === where.address) ?? null,
      create: async ({ data }: { data: LeaderboardRow }) => {
        leaderboard.push(data);
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { address: string };
        data: Record<string, any>;
      }) => {
        const user = leaderboard.find(candidate => candidate.address === where.address);
        return applyUpdate(user!, data);
      },
    },
    mockBet: {
      create: async ({ data }: { data: BetRow }) => {
        bets.push(data);
        return data;
      },
    },
    mockRound: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rounds.find(round => round.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, any>;
      }) => {
        const round = rounds.find(candidate => candidate.id === where.id);
        return applyUpdate(round!, data);
      },
    },
  };

  return {
    __esModule: true,
    prisma: {
      ...delegates,
      $transaction: async (fn: (tx: typeof delegates) => Promise<unknown>) => {
        transactionCount += 1;
        return fn(delegates);
      },
    },
  };
});

import hackathonService from '../services/hackathon.service';

const ADDRESS = 'GBETTORADDRESS0000000000000000000000000000000000000000000';

describe('HackathonService - placeBet', () => {
  beforeEach(() => {
    leaderboard = [
      {
        address: ADDRESS,
        balance: 1000,
        pendingWinnings: 0,
        totalWins: 0,
        totalLosses: 0,
        winStreak: 0,
        xp: 0,
        rankTitle: 'Rookie',
      },
    ];
    rounds = [
      {
        id: 'updown-round',
        mode: 'updown',
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
      },
    ];
    bets = [];
    transactionCount = 0;
  });

  it('exposes a single positional placeBet contract', () => {
    // roundId, address, amount, side, predictedPrice - no object/overload form.
    expect(hackathonService.placeBet.length).toBe(5);
  });

  it('records the bet and debits the balance', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 100, 'UP');

    expect(bets).toEqual([
      {
        roundId: 'updown-round',
        address: ADDRESS,
        amount: 100,
        side: 'UP',
        predictedPrice: undefined,
      },
    ]);
    expect(leaderboard[0].balance).toBe(900);
  });

  it('increments poolUp for an UP bet', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 100, 'UP');

    expect(rounds[0].poolUp).toBe(100);
    expect(rounds[0].poolDown).toBe(0);
  });

  it('increments poolDown for a DOWN bet', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 75, 'DOWN');

    expect(rounds[0].poolUp).toBe(0);
    expect(rounds[0].poolDown).toBe(75);
  });

  it('accumulates pools with Decimal-safe arithmetic', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 0.1, 'UP');
    await hackathonService.placeBet('updown-round', ADDRESS, 0.2, 'UP');

    // 0.1 + 0.2 is 0.3, not the 0.30000000000000004 native float math gives.
    expect(rounds[0].poolUp).toBe(0.3);
    expect(leaderboard[0].balance).toBe(999.7);
  });

  it('creates a leaderboard row for a first-time bettor', async () => {
    leaderboard = [];

    await hackathonService.placeBet('updown-round', ADDRESS, 100, 'UP');

    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0].address).toBe(ADDRESS);
    expect(leaderboard[0].balance).toBe(900);
  });

  it('updates totalPool and predictionCount for precision rounds', async () => {
    rounds = [
      {
        id: 'precision-round',
        mode: 'precision',
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
      },
    ];

    await hackathonService.placeBet('precision-round', ADDRESS, 250, undefined, 3250);

    expect(rounds[0].totalPool).toBe(250);
    expect(rounds[0].predictionCount).toBe(1);
    expect(bets[0].predictedPrice).toBe(3250);
  });

  it('runs the whole bet inside a single transaction', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 100, 'UP');

    expect(transactionCount).toBe(1);
  });

  it('debits the balance and grows the pool for every bet in a sequence', async () => {
    await hackathonService.placeBet('updown-round', ADDRESS, 0.2, 'UP');
    await hackathonService.placeBet('updown-round', ADDRESS, 0.2, 'UP');

    expect(leaderboard[0].balance).toBe(999.6);
    expect(rounds[0].poolUp).toBe(0.4);
  });

  it('propagates a transaction failure to the caller', async () => {
    const { prisma } = await import('../lib/prisma');
    const spy = jest
      .spyOn(prisma as any, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated transaction failure'));

    await expect(
      hackathonService.placeBet('updown-round', ADDRESS, 100, 'UP'),
    ).rejects.toThrow('Simulated transaction failure');

    spy.mockRestore();
  });
});
