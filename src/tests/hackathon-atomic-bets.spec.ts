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

// Private rounds keep this suite's before/after snapshots isolated from the
// seeded global rounds used by other hackathon integration specs. Those specs
// can run in parallel in CI, so sharing 'btc-updown-live' made the deltas flaky.
const ATOMIC_UPDOWN_ROUND_ID = 'atomic-test-updown';
const ATOMIC_PRECISION_ROUND_ID = 'atomic-test-precision';
const TEST_ROUND_IDS = [ATOMIC_UPDOWN_ROUND_ID, ATOMIC_PRECISION_ROUND_ID];
const CLOSES_AT = '2099-01-01T00:00:00.000Z';

const updownRound = {
  id: ATOMIC_UPDOWN_ROUND_ID,
  asset: 'BTC',
  mode: 'updown',
  status: 'live',
  startPrice: 67420,
  poolUp: 2800,
  poolDown: 1400,
  totalPool: null,
  predictionCount: null,
  closesAt: CLOSES_AT,
};

const precisionRound = {
  id: ATOMIC_PRECISION_ROUND_ID,
  asset: 'ETH',
  mode: 'precision',
  status: 'live',
  startPrice: 3241,
  poolUp: null,
  poolDown: null,
  totalPool: 1800,
  predictionCount: 22,
  closesAt: CLOSES_AT,
};

async function resetRound(
  data: typeof updownRound | typeof precisionRound,
): Promise<void> {
  await prisma.mockRound.upsert({
    where: { id: data.id },
    update: data,
    create: data,
  });
}

async function readTestRounds() {
  return prisma.mockRound.findMany({
    where: { id: { in: TEST_ROUND_IDS } },
    orderBy: { id: 'asc' },
  });
}

describe('Hackathon Atomic Bets', () => {
  beforeAll(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
    await resetRound(updownRound);
    await resetRound(precisionRound);
  });

  beforeEach(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
    await resetRound(updownRound);
    await resetRound(precisionRound);
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
  });

  afterAll(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockRound.deleteMany({ where: { id: { in: TEST_ROUND_IDS } } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
  });

  describe('happy path', () => {
    it('atomically inserts bet, deducts balance, and updates pool for UP/DOWN mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: ATOMIC_UPDOWN_ROUND_ID } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      expect(roundBefore).not.toBeNull();

      await hackathonService.placeBet(ATOMIC_UPDOWN_ROUND_ID, TEST_ADDRESS, 200, 'UP');

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: ATOMIC_UPDOWN_ROUND_ID } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === ATOMIC_UPDOWN_ROUND_ID);
      expect(freshBet).toBeDefined();
      expect(freshBet!.amount).toBe(200);
      expect(freshBet!.side).toBe('UP');
      expect(userAfter!.balance).toBe(userBefore!.balance - 200);
      expect(roundAfter!.poolUp).toBe(roundBefore!.poolUp! + 200);
    });

    it('atomically inserts bet and updates totalPool for Precision mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: ATOMIC_PRECISION_ROUND_ID } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      expect(roundBefore).not.toBeNull();

      await hackathonService.placeBet(ATOMIC_PRECISION_ROUND_ID, TEST_ADDRESS, 150, undefined, 3250);

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: ATOMIC_PRECISION_ROUND_ID } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === ATOMIC_PRECISION_ROUND_ID);
      expect(freshBet).toBeDefined();
      expect(freshBet!.amount).toBe(150);
      expect(freshBet!.predictedPrice).toBe(3250);
      expect(userAfter!.balance).toBe(userBefore!.balance - 150);
      expect(roundAfter!.totalPool).toBe(roundBefore!.totalPool! + 150);
      expect(roundAfter!.predictionCount).toBe(roundBefore!.predictionCount! + 1);
    });
  });

  describe('rollback on failure', () => {
    it('rolls back all changes when FK constraint is violated (non-existent round)', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await readTestRounds();

      await expect(
        hackathonService.placeBet('nonexistent-round-id', TEST_ADDRESS, 100, 'UP')
      ).rejects.toThrow();

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await readTestRounds();
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'nonexistent-round-id' },
      });

      expect(bets.length).toBe(0);
      expect(userAfter!.balance).toBe(userBefore!.balance);
      expect(roundsAfter).toEqual(roundsBefore);
    });

    it('rolls back all changes when transaction throws', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await readTestRounds();

      const txSpy = jest.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Simulated transaction failure'));

      try {
        await expect(
          hackathonService.placeBet(ATOMIC_UPDOWN_ROUND_ID, TEST_ADDRESS, 100, 'UP')
        ).rejects.toThrow('Simulated transaction failure');

        const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
        const roundsAfter = await readTestRounds();
        const bets = await prisma.mockBet.findMany({
          where: { address: TEST_ADDRESS, roundId: ATOMIC_UPDOWN_ROUND_ID },
        });

        expect(bets.length).toBe(0);
        expect(userAfter!.balance).toBe(userBefore!.balance);
        expect(roundsAfter).toEqual(roundsBefore);
      } finally {
        txSpy.mockRestore();
      }
    });
  });

  describe('concurrent bets', () => {
    it('handles concurrent bet placement without data corruption', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: ATOMIC_UPDOWN_ROUND_ID } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      expect(roundBefore).not.toBeNull();

      const promises = [
        hackathonService.placeBet(ATOMIC_UPDOWN_ROUND_ID, TEST_ADDRESS, 100, 'UP'),
        hackathonService.placeBet(ATOMIC_UPDOWN_ROUND_ID, TEST_ADDRESS, 200, 'DOWN'),
        hackathonService.placeBet(ATOMIC_UPDOWN_ROUND_ID, TEST_ADDRESS, 50, 'UP'),
      ];

      await expect(Promise.all(promises)).resolves.toEqual([undefined, undefined, undefined]);

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: ATOMIC_UPDOWN_ROUND_ID } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const roundBets = bets.filter(b => b.roundId === ATOMIC_UPDOWN_ROUND_ID);
      expect(roundBets.length).toBe(3);

      const totalBetAmount = roundBets.reduce((sum, b) => sum + b.amount, 0);
      expect(userAfter!.balance).toBe(userBefore!.balance - totalBetAmount);
      expect(roundAfter!.poolUp).toBe(roundBefore!.poolUp! + 100 + 50);
      expect(roundAfter!.poolDown).toBe(roundBefore!.poolDown! + 200);
    });
  });
});
