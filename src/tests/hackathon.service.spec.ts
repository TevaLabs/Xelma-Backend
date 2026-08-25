import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockRoundStore = new Map<string, any>();
const mockLeaderboardStore = new Map<string, any>();
const mockBetStore: any[] = [];

jest.mock('../lib/prisma', () => ({
  prisma: {
    mockRound: {
      findMany: jest.fn(async () => Array.from(mockRoundStore.values())),
      findUnique: jest.fn(async ({ where }: any) => mockRoundStore.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = mockRoundStore.get(where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data };
        mockRoundStore.set(where.id, updated);
        return updated;
      }),
    },
    mockLeaderboard: {
      findMany: jest.fn(async ({ orderBy }: any = {}) => {
        const all = Array.from(mockLeaderboardStore.values());
        if (orderBy?.xp === 'desc') all.sort((a, b) => b.xp - a.xp);
        return all;
      }),
      findUnique: jest.fn(async ({ where }: any) => mockLeaderboardStore.get(where.address) ?? null),
      create: jest.fn(async ({ data }: any) => {
        mockLeaderboardStore.set(data.address, { ...data });
        return { ...data };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = mockLeaderboardStore.get(where.address);
        if (!existing) return null;
        const updated = { ...existing, ...data };
        mockLeaderboardStore.set(where.address, updated);
        return updated;
      }),
    },
    mockBet: {
      create: jest.fn(async ({ data }: any) => {
        const record = { id: mockBetStore.length + 1, createdAt: new Date(), ...data };
        mockBetStore.push(record);
        return record;
      }),
      findMany: jest.fn(async () => mockBetStore),
    },
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import hackathonService from '../services/hackathon.service';

function seedUser(address: string, balance: number) {
  mockLeaderboardStore.set(address, {
    address,
    rank: 0,
    balance,
    pendingWinnings: 0,
    totalWins: 0,
    totalLosses: 0,
    winStreak: 0,
    xp: 0,
    rankTitle: 'Rookie',
  });
}

function seedRound(id: string, overrides: Record<string, any> = {}) {
  const round = {
    id,
    asset: 'BTC',
    mode: 'updown',
    status: 'live',
    startPrice: 60000,
    poolUp: 0,
    poolDown: 0,
    totalPool: null,
    predictionCount: null,
    closesAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
  mockRoundStore.set(id, round);
  return round;
}

beforeEach(() => {
  mockRoundStore.clear();
  mockLeaderboardStore.clear();
  mockBetStore.length = 0;
  jest.clearAllMocks();
});

describe('HackathonService - placeBet', () => {
  const address = 'user-hack-test-1';
  const roundId = 'round-hack-test-1';

  beforeEach(() => {
    seedUser(address, 1000);
    seedRound(roundId);
  });

  describe('Balance Deduction', () => {
    it('deducts the bet amount from the user balance', async () => {
      await hackathonService.placeBet(roundId, address, 100, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBe(900);
    });

    it('floors balance at zero when bet exceeds available balance', async () => {
      seedUser(address, 50);

      await hackathonService.placeBet(roundId, address, 100, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBe(0);
    });

    it('floors balance at zero when balance is exactly zero', async () => {
      seedUser(address, 0);

      await hackathonService.placeBet(roundId, address, 1, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBe(0);
    });

    it('floors balance at zero for fractional overdraft', async () => {
      seedUser(address, 0.00000001);

      await hackathonService.placeBet(roundId, address, 0.01, 'DOWN');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBe(0);
    });

    it('still places the bet even when balance is insufficient', async () => {
      seedUser(address, 50);

      await hackathonService.placeBet(roundId, address, 100, 'UP');

      expect(mockBetStore.length).toBe(1);
      expect(mockBetStore[0].amount).toBe(100);
      expect(mockBetStore[0].side).toBe('UP');
    });
  });

  describe('Pool Increments', () => {
    it('increments poolUp when betting UP', async () => {
      await hackathonService.placeBet(roundId, address, 100, 'UP');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(100);
      expect(round.poolDown).toBe(0);
    });

    it('increments poolDown when betting DOWN', async () => {
      await hackathonService.placeBet(roundId, address, 100, 'DOWN');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(0);
      expect(round.poolDown).toBe(100);
    });

    it('accumulates poolUp across multiple UP bets', async () => {
      const user2 = 'user-hack-test-2';
      seedUser(user2, 1000);

      await hackathonService.placeBet(roundId, address, 50, 'UP');
      await hackathonService.placeBet(roundId, user2, 75, 'UP');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(125);
      expect(round.poolDown).toBe(0);
    });

    it('accumulates poolDown across multiple DOWN bets', async () => {
      const user2 = 'user-hack-test-3';
      seedUser(user2, 1000);

      await hackathonService.placeBet(roundId, address, 30, 'DOWN');
      await hackathonService.placeBet(roundId, user2, 45, 'DOWN');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(0);
      expect(round.poolDown).toBe(75);
    });

    it('maintains separate poolUp and poolDown for mixed sides', async () => {
      const user2 = 'user-hack-test-4';
      seedUser(user2, 1000);

      await hackathonService.placeBet(roundId, address, 100, 'UP');
      await hackathonService.placeBet(roundId, user2, 50, 'DOWN');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(100);
      expect(round.poolDown).toBe(50);
    });

    it('pool totals equal sum of all bets on each side', async () => {
      await hackathonService.placeBet(roundId, address, 10, 'UP');
      await hackathonService.placeBet(roundId, address, 20, 'UP');
      await hackathonService.placeBet(roundId, address, 30, 'UP');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(60);
      expect(round.poolDown).toBe(0);
    });
  });

  describe('Bet Recording', () => {
    it('creates a bet record with correct fields', async () => {
      await hackathonService.placeBet(roundId, address, 100, 'UP');

      expect(mockBetStore.length).toBe(1);
      expect(mockBetStore[0]).toMatchObject({
        roundId,
        address,
        amount: 100,
        side: 'UP',
      });
    });

    it('records multiple bets', async () => {
      await hackathonService.placeBet(roundId, address, 100, 'UP');
      await hackathonService.placeBet(roundId, address, 50, 'DOWN');

      expect(mockBetStore.length).toBe(2);
      expect(mockBetStore[0].side).toBe('UP');
      expect(mockBetStore[1].side).toBe('DOWN');
    });
  });

  describe('Precision', () => {
    it('handles fractional amounts without precision loss', async () => {
      await hackathonService.placeBet(roundId, address, 0.1, 'UP');
      await hackathonService.placeBet(roundId, address, 0.2, 'UP');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBeCloseTo(0.3, 8);
    });

    it('handles very small amounts', async () => {
      await hackathonService.placeBet(roundId, address, 0.00000001, 'UP');

      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(0.00000001);
    });

    it('deducts fractional balance correctly', async () => {
      await hackathonService.placeBet(roundId, address, 0.12345678, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBeCloseTo(999.87654322, 8);
    });

    it('deducts 33.33333333 and floors balance correctly', async () => {
      await hackathonService.placeBet(roundId, address, 33.33333333, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.balance).toBeCloseTo(966.66666667, 8);
    });
  });

  describe('Round Validation', () => {
    it('still places the bet when round does not exist (no pool update)', async () => {
      await hackathonService.placeBet('nonexistent', address, 10, 'UP');

      expect(mockBetStore.length).toBe(1);
      expect(mockBetStore[0].roundId).toBe('nonexistent');
    });

    it('still places the bet and updates pool when round status is not live', async () => {
      seedRound(roundId, { status: 'resolved' });

      await hackathonService.placeBet(roundId, address, 10, 'UP');

      expect(mockBetStore.length).toBe(1);
      const round = mockRoundStore.get(roundId)!;
      expect(round.poolUp).toBe(10);
    });
  });

  describe('User Creation', () => {
    it('creates a new leaderboard entry when user does not exist', async () => {
      const newAddress = 'brand-new-user';

      await hackathonService.placeBet(roundId, newAddress, 100, 'UP');

      const user = mockLeaderboardStore.get(newAddress)!;
      expect(user).toBeDefined();
      expect(user.balance).toBe(900);
      expect(user.rankTitle).toBe('Rookie');
    });

    it('does not overwrite existing user data', async () => {
      seedUser(address, 1000);
      mockLeaderboardStore.get(address).xp = 500;

      await hackathonService.placeBet(roundId, address, 100, 'UP');

      const user = mockLeaderboardStore.get(address)!;
      expect(user.xp).toBe(500);
    });
  });
});

describe('HackathonService - getRounds', () => {
  it('returns all rounds', async () => {
    seedRound('r1', { asset: 'BTC' });
    seedRound('r2', { asset: 'ETH', mode: 'precision', poolUp: null, poolDown: null, totalPool: 0, predictionCount: 0 });

    const rounds = await hackathonService.getRounds();
    expect(rounds).toHaveLength(2);
  });

  it('returns poolUp/poolDown for updown mode', async () => {
    seedRound('r1', { mode: 'updown', poolUp: 100, poolDown: 200 });

    const rounds = await hackathonService.getRounds();
    const r = rounds.find((x: any) => x.id === 'r1')!;
    expect(r.poolUp).toBe(100);
    expect(r.poolDown).toBe(200);
  });

  it('returns totalPool/predictionCount for precision mode', async () => {
    seedRound('r1', { mode: 'precision', totalPool: 500, predictionCount: 10 });

    const rounds = await hackathonService.getRounds();
    const r = rounds.find((x: any) => x.id === 'r1')!;
    expect(r.totalPool).toBe(500);
    expect(r.predictionCount).toBe(10);
  });
});

describe('HackathonService - getLeaderboard', () => {
  it('returns top 10 users sorted by xp descending', async () => {
    for (let i = 1; i <= 12; i++) {
      seedUser(`user-${i}`, 1000);
      mockLeaderboardStore.get(`user-${i}`).xp = i * 10;
    }

    const leaderboard = await hackathonService.getLeaderboard();
    expect(leaderboard).toHaveLength(10);
    expect(leaderboard[0].rank).toBe(1);
    expect(leaderboard[0].xp).toBe(120);
    expect(leaderboard[9].xp).toBe(30);
  });

  it('returns empty array when no users exist', async () => {
    const leaderboard = await hackathonService.getLeaderboard();
    expect(leaderboard).toEqual([]);
  });

  it('includes rank, address, totalWins, totalLosses, winStreak, xp, rankTitle', async () => {
    seedUser('user-1', 1000);
    const u = mockLeaderboardStore.get('user-1');
    u.totalWins = 5;
    u.totalLosses = 2;
    u.winStreak = 3;
    u.xp = 100;
    u.rankTitle = 'Champion';

    const leaderboard = await hackathonService.getLeaderboard();
    expect(leaderboard[0]).toMatchObject({
      rank: 1,
      address: 'user-1',
      totalWins: 5,
      totalLosses: 2,
      winStreak: 3,
      xp: 100,
      rankTitle: 'Champion',
    });
  });
});

describe('HackathonService - getUserStats', () => {
  const testAddress = 'user-stats-test-1';

  it('returns existing user stats', async () => {
    seedUser(testAddress, 500);
    const u = mockLeaderboardStore.get(testAddress);
    u.totalWins = 10;
    u.totalLosses = 3;
    u.winStreak = 5;
    u.xp = 800;
    u.rankTitle = 'Expert';
    u.pendingWinnings = 25;

    const stats = await hackathonService.getUserStats(testAddress);
    expect(stats).toMatchObject({
      address: testAddress,
      balance: 500,
      pendingWinnings: 25,
      totalWins: 10,
      totalLosses: 3,
      currentStreak: 5,
      xp: 800,
      rankTitle: 'Expert',
    });
  });

  it('creates and returns default stats for unknown user', async () => {
    const stats = await hackathonService.getUserStats('unknown-user');
    expect(stats).toMatchObject({
      address: 'unknown-user',
      balance: 1000,
      pendingWinnings: 0,
      totalWins: 3,
      totalLosses: 1,
      currentStreak: 3,
      xp: 410,
      rankTitle: 'Rookie',
    });
  });

  it('persists the default entry to the leaderboard', async () => {
    await hackathonService.getUserStats('new-user');
    expect(mockLeaderboardStore.has('new-user')).toBe(true);
  });
});
