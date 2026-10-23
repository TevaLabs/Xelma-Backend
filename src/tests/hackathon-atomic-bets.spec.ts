import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import hackathonService from '../services/hackathon.service';
import { prisma } from '../lib/prisma';

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: () => true,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

const TEST_ADDRESS = 'GAAAAATOMIC_BET_TEST_ADDR_000000000000000001';
const UP_DOWN_ROUND = 'atomic-test-updown-round';
const PRECISION_ROUND = 'atomic-test-precision-round';

// Dedicated rounds per suite: other hackathon specs bet on the shared seeded
// rounds (e.g. btc-updown-live) in parallel Jest workers, which made the exact
// pool/balance assertions here flaky. Creating our own rows removes the
// cross-suite race while still exercising the real transactional path.
const ROUND_IDS = [UP_DOWN_ROUND, PRECISION_ROUND];

async function resetRounds(): Promise<void> {
  await prisma.mockBet.deleteMany({ where: { roundId: { in: ROUND_IDS } } });
  await prisma.mockRound.deleteMany({ where: { id: { in: ROUND_IDS } } });
  await prisma.mockRound.createMany({
    data: [
      {
        id: UP_DOWN_ROUND,
        asset: 'BTC',
        mode: 'updown',
        status: 'live',
        startPrice: 60000,
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
        closesAt: new Date(Date.now() + 300_000).toISOString(),
      },
      {
        id: PRECISION_ROUND,
        asset: 'ETH',
        mode: 'precision',
        status: 'live',
        startPrice: 3000,
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
        closesAt: new Date(Date.now() + 300_000).toISOString(),
      },
    ],
  });
}

describe('Hackathon Atomic Bets', () => {
  beforeAll(async () => {
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
    await resetRounds();
  });

  beforeEach(async () => {
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockLeaderboard.create({
      data: {
        address: TEST_ADDRESS,
        rank: 0,
        balance: 5000,
        pendingWinnings: 0,
        totalWins: 3,
        totalLosses: 1,
        winStreak: 3,
        xp: 410,
        rankTitle: 'Rookie',
      },
    });
    await prisma.mockBet.deleteMany({ where: { roundId: { in: ROUND_IDS } } });
    await prisma.mockRound.updateMany({
      where: { id: { in: ROUND_IDS } },
      data: { poolUp: 0, poolDown: 0, totalPool: 0, predictionCount: 0 },
    });
  });

  afterAll(async () => {
    await prisma.mockBet.deleteMany({ where: { roundId: { in: ROUND_IDS } } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockRound.deleteMany({ where: { id: { in: ROUND_IDS } } });
  });

  describe('happy path', () => {
    it('atomically inserts bet, deducts balance, and updates pool for UP/DOWN mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: UP_DOWN_ROUND } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await hackathonService.placeBet(UP_DOWN_ROUND, TEST_ADDRESS, 200, 'UP');

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: UP_DOWN_ROUND } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === UP_DOWN_ROUND);
      expect(freshBet).toBeDefined();
      expect(freshBet!.amount).toBe(200);
      expect(freshBet!.side).toBe('UP');
      expect(userAfter!.balance).toBe(userBefore!.balance - 200);
      expect(roundAfter!.poolUp).toBe(roundBefore!.poolUp! + 200);
    });

    it('atomically inserts bet and updates totalPool for Precision mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: PRECISION_ROUND } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await hackathonService.placeBet(PRECISION_ROUND, TEST_ADDRESS, 150, undefined, 3250);

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: PRECISION_ROUND } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === PRECISION_ROUND);
      expect(freshBet).toBeDefined();
      expect(freshBet!.amount).toBe(150);
      expect(freshBet!.predictedPrice).toBe(3250);
      expect(userAfter!.balance).toBe(userBefore!.balance - 150);
      expect(roundAfter!.totalPool).toBe(roundBefore!.totalPool! + 150);
      expect(roundAfter!.predictionCount).toBe(roundBefore!.predictionCount! + 1);
    });
  });

  describe('rollback on failure', () => {
    it('rolls back all changes when the round does not exist', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await prisma.mockRound.findMany({ orderBy: { id: 'asc' } });

      await expect(
        hackathonService.placeBet('nonexistent-round-id', TEST_ADDRESS, 100, 'UP')
      ).rejects.toThrow('Round not found');

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await prisma.mockRound.findMany({ orderBy: { id: 'asc' } });
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'nonexistent-round-id' },
      });

      expect(bets.length).toBe(0);
      expect(userAfter!.balance).toBe(userBefore!.balance);
      expect(roundsAfter).toEqual(roundsBefore);
    });

    it('rolls back all changes when transaction throws', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await prisma.mockRound.findMany({ orderBy: { id: 'asc' } });

      const txSpy = jest.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Simulated transaction failure'));

      try {
        await expect(
          hackathonService.placeBet(UP_DOWN_ROUND, TEST_ADDRESS, 100, 'UP')
        ).rejects.toThrow('Simulated transaction failure');
      } finally {
        txSpy.mockRestore();
      }

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await prisma.mockRound.findMany({ orderBy: { id: 'asc' } });
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: UP_DOWN_ROUND },
      });

      expect(bets.length).toBe(0);
      expect(userAfter!.balance).toBe(userBefore!.balance);
      expect(roundsAfter).toEqual(roundsBefore);
    });
  });

  describe('concurrent bets', () => {
    it('handles concurrent bet placement without data corruption', async () => {
      const roundId = UP_DOWN_ROUND;
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: roundId } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      const promises = [
        hackathonService.placeBet(roundId, TEST_ADDRESS, 100, 'UP'),
        hackathonService.placeBet(roundId, TEST_ADDRESS, 200, 'DOWN'),
        hackathonService.placeBet(roundId, TEST_ADDRESS, 50, 'UP'),
      ];

      await expect(Promise.all(promises)).resolves.toEqual([undefined, undefined, undefined]);

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: roundId } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const roundBets = bets.filter(b => b.roundId === roundId);
      expect(roundBets.length).toBe(3);

      const totalBetAmount = roundBets.reduce((sum, b) => sum + b.amount, 0);
      expect(userAfter!.balance).toBe(userBefore!.balance - totalBetAmount);
      expect(roundAfter!.poolUp).toBe(roundBefore!.poolUp! + 100 + 50);
      expect(roundAfter!.poolDown).toBe(roundBefore!.poolDown! + 200);
    });
  });
});
