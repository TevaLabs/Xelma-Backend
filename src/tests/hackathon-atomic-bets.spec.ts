import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import hackathonService from '../services/hackathon.service';
import { prisma } from '../lib/prisma';
import { toNumber } from '../utils/decimal.util';

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

describe('Hackathon Atomic Bets', () => {
  beforeAll(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
  });

  beforeEach(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
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
  });

  afterAll(async () => {
    await prisma.mockBet.deleteMany({ where: { address: TEST_ADDRESS } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: TEST_ADDRESS } });
  });

  describe('happy path', () => {
    it('atomically inserts bet, deducts balance, and updates pool for UP/DOWN mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await hackathonService.placeBet('btc-updown-live', TEST_ADDRESS, 200, 'UP');

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === 'btc-updown-live');
      expect(freshBet).toBeDefined();
      // Mock money columns are Decimal(20, 8), so compare numerically.
      expect(toNumber(freshBet!.amount)).toBe(200);
      expect(freshBet!.side).toBe('UP');
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance) - 200);
      expect(toNumber(roundAfter!.poolUp)).toBe(toNumber(roundBefore!.poolUp) + 200);

      // Single-store consistency: the debit, the pool move and the recorded
      // bet are the same number — no ledger is left behind.
      expect(toNumber(userBefore!.balance) - toNumber(userAfter!.balance)).toBe(toNumber(freshBet!.amount));
      expect(toNumber(roundAfter!.poolUp) - toNumber(roundBefore!.poolUp)).toBe(toNumber(freshBet!.amount));
    });

    it('atomically inserts bet and updates totalPool for Precision mode', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await hackathonService.placeBet('eth-precision-live', TEST_ADDRESS, 150, undefined, 3250);

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({ where: { address: TEST_ADDRESS } });

      const freshBet = bets.find(b => b.roundId === 'eth-precision-live');
      expect(freshBet).toBeDefined();
      expect(toNumber(freshBet!.amount)).toBe(150);
      expect(toNumber(freshBet!.predictedPrice)).toBe(3250);
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance) - 150);
      expect(toNumber(roundAfter!.totalPool)).toBe(toNumber(roundBefore!.totalPool) + 150);
      expect(roundAfter!.predictionCount).toBe(roundBefore!.predictionCount! + 1);
    });

    it('stores fractional stakes without float drift (0.1 + 0.2 is exactly 0.3)', async () => {
      const roundId = 'btc-updown-live';
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: roundId } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await hackathonService.placeBet(roundId, TEST_ADDRESS, 0.1, 'UP');
      await hackathonService.placeBet(roundId, TEST_ADDRESS, 0.2, 'UP');

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: roundId } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      // The real Decimal(20, 8) column adds exactly — native floats would give
      // 0.30000000000000004 here.
      expect(roundAfter!.poolUp!.minus(roundBefore!.poolUp!).toFixed(8)).toBe('0.30000000');
      expect(userAfter!.balance.minus(userBefore!.balance).toFixed(8)).toBe('-0.30000000');
    });
  });

  describe('rollback on failure', () => {
    it('rolls back all changes when the round does not exist', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await prisma.mockRound.findMany();

      await expect(
        hackathonService.placeBet('nonexistent-round-id', TEST_ADDRESS, 100, 'UP')
      ).rejects.toThrow('Round not found');

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await prisma.mockRound.findMany();
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'nonexistent-round-id' },
      });

      expect(bets.length).toBe(0);
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance));
      expect(roundsAfter).toEqual(roundsBefore);
    });

    it('rolls back all changes when transaction throws', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await prisma.mockRound.findMany();

      const txSpy = jest.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Simulated transaction failure'));

      await expect(
        hackathonService.placeBet('btc-updown-live', TEST_ADDRESS, 100, 'UP')
      ).rejects.toThrow('Simulated transaction failure');

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await prisma.mockRound.findMany();
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'btc-updown-live' },
      });

      expect(bets.length).toBe(0);
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance));
      expect(roundsAfter).toEqual(roundsBefore);

      txSpy.mockRestore();
    });

    it('does not debit the balance or move the pool on an overdraft', async () => {
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });

      await expect(
        hackathonService.placeBet('btc-updown-live', TEST_ADDRESS, toNumber(userBefore!.balance) + 1, 'UP')
      ).rejects.toThrow('Insufficient balance');

      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'btc-updown-live' },
      });

      expect(bets.length).toBe(0);
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance));
      expect(toNumber(roundAfter!.poolUp)).toBe(toNumber(roundBefore!.poolUp));
    });
  });

  describe('concurrent bets', () => {
    it('handles concurrent bet placement without data corruption', async () => {
      const roundId = 'btc-updown-live';
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

      const totalBetAmount = roundBets.reduce((sum, b) => sum + toNumber(b.amount), 0);
      expect(toNumber(userAfter!.balance)).toBe(toNumber(userBefore!.balance) - totalBetAmount);
      expect(toNumber(roundAfter!.poolUp)).toBe(toNumber(roundBefore!.poolUp) + 100 + 50);
      expect(toNumber(roundAfter!.poolDown)).toBe(toNumber(roundBefore!.poolDown) + 200);
    });
  });
});
