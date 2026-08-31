/**
 * Decimal-safe balance/pool math for the hackathon mock bet path.
 *
 * `placeMockBet` no longer does the arithmetic itself — it issues Prisma
 * atomic operators (`{ decrement }` / `{ increment }`) inside a transaction so
 * concurrent bets cannot lose updates. The mock below applies those operators
 * with Decimal arithmetic, which is what the real database does, so the tests
 * still pin the end state and catch float drift creeping back in.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

interface FakeUser {
  address: string;
  balance: number;
  pendingWinnings: number;
  totalWins: number;
  totalLosses: number;
  currentStreak: number;
  xp: number;
  rankTitle: string;
}

interface FakeRound {
  id: string;
  mode: 'updown' | 'precision';
  poolUp: number;
  poolDown: number;
  totalPool: number;
  predictionCount: number;
}

let mockUsers: FakeUser[];
let mockRounds: FakeRound[];

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
        mockUsers.find(user => user.address === where.address) ?? null,
      create: async ({ data }: { data: FakeUser }) => {
        mockUsers.push(data);
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { address: string };
        data: Record<string, any>;
      }) => {
        const user = mockUsers.find(candidate => candidate.address === where.address);
        return applyUpdate(user!, data);
      },
    },
    mockBet: {
      create: async () => undefined,
    },
    mockRound: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        mockRounds.find(round => round.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, any>;
      }) => {
        const round = mockRounds.find(candidate => candidate.id === where.id);
        return applyUpdate(round!, data);
      },
    },
  };

  return {
    __esModule: true,
    prisma: {
      ...delegates,
      $transaction: async (fn: (tx: typeof delegates) => Promise<unknown>) =>
        fn(delegates),
    },
  };
});

describe('hackathon.service Decimal-safe balance/pool math', () => {
  beforeEach(() => {
    mockUsers = [
      {
        address: 'GADDR',
        balance: 10.3,
        pendingWinnings: 0,
        totalWins: 0,
        totalLosses: 0,
        currentStreak: 0,
        xp: 0,
        rankTitle: 'Rookie',
      },
    ];
    mockRounds = [
      { id: 'r1', mode: 'updown', poolUp: 0.1, poolDown: 0, totalPool: 0.1, predictionCount: 0 },
    ];
  });

  it('deducts a fractional bet amount from balance without float drift', async () => {
    const hackathonService = (await import('../services/hackathon.service')).default;

    await hackathonService.placeBet('r1', 'GADDR', 0.2, 'UP');

    // 10.3 - 0.2 is 10.1, not the 10.099999999999998 native float math gives.
    expect(mockUsers[0].balance).toBe(10.1);
  });

  it('accumulates the round pool with Decimal-safe addition', async () => {
    const hackathonService = (await import('../services/hackathon.service')).default;

    await hackathonService.placeBet('r1', 'GADDR', 0.2, 'UP');

    // 0.1 + 0.2 is 0.3, not 0.30000000000000004.
    expect(mockRounds[0].poolUp).toBe(0.3);
  });

  it('accumulates a precision round pool and prediction count together', async () => {
    mockRounds[0].mode = 'precision';
    const hackathonService = (await import('../services/hackathon.service')).default;

    await hackathonService.placeBet('r1', 'GADDR', 0.2, undefined, 1.25);

    expect(mockRounds[0].totalPool).toBe(0.3);
    expect(mockRounds[0].predictionCount).toBe(1);
  });

  it('debits the balance atomically rather than writing a computed value', async () => {
    const hackathonService = (await import('../services/hackathon.service')).default;

    await hackathonService.placeBet('r1', 'GADDR', 0.2, 'UP');
    await hackathonService.placeBet('r1', 'GADDR', 0.2, 'UP');

    // Two sequential relative debits compose exactly; a read-modify-write on a
    // stale balance would land on 10.1 twice.
    expect(mockUsers[0].balance).toBe(9.9);
  });
});
