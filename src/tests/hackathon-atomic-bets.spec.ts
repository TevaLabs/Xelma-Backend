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
      expect(freshBet!.amount.toNumber()).toBe(200);
      expect(freshBet!.side).toBe('UP');
      expect(userAfter!.balance.toNumber()).toBe(userBefore!.balance.toNumber() - 200);
      expect(roundAfter!.poolUp!.toNumber()).toBe((roundBefore!.poolUp?.toNumber() ?? 0) + 200);
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
      expect(freshBet!.amount.toNumber()).toBe(150);
      expect(freshBet!.predictedPrice!.toNumber()).toBe(3250);
      expect(userAfter!.balance.toNumber()).toBe(userBefore!.balance.toNumber() - 150);
      expect(roundAfter!.totalPool!.toNumber()).toBe((roundBefore!.totalPool?.toNumber() ?? 0) + 150);
      expect(roundAfter!.predictionCount).toBe((roundBefore!.predictionCount ?? 0) + 1);
    });
  });

  describe('rollback on failure', () => {
    it('rolls back all changes when FK constraint is violated (non-existent round)', async () => {
      const userBefore = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsBefore = await prisma.mockRound.findMany();

      await expect(
        hackathonService.placeBet('nonexistent-round-id', TEST_ADDRESS, 100, 'UP')
      ).rejects.toThrow();

      const userAfter = await prisma.mockLeaderboard.findUnique({ where: { address: TEST_ADDRESS } });
      const roundsAfter = await prisma.mockRound.findMany();
      const bets = await prisma.mockBet.findMany({
        where: { address: TEST_ADDRESS, roundId: 'nonexistent-round-id' },
      });

      expect(bets.length).toBe(0);
      expect(userAfter!.balance.toString()).toBe(userBefore!.balance.toString());
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
      expect(userAfter!.balance.toString()).toBe(userBefore!.balance.toString());
      expect(roundsAfter).toEqual(roundsBefore);
      
      txSpy.mockRestore();
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

      const totalBetAmount = roundBets.reduce((sum, b) => sum + b.amount.toNumber(), 0);
      expect(userAfter!.balance.toNumber()).toBe(userBefore!.balance.toNumber() - totalBetAmount);
      expect(roundAfter!.poolUp!.toNumber()).toBe((roundBefore!.poolUp?.toNumber() ?? 0) + 100 + 50);
      expect(roundAfter!.poolDown!.toNumber()).toBe((roundBefore!.poolDown?.toNumber() ?? 0) + 200);
    });
  });
});
