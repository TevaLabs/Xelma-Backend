import { mockDataRepository } from '../repositories/mockData.repository';

// Mock the prisma client directly using standard jest mocks
jest.mock('../lib/prisma', () => {
  return {
    prisma: {
      mockRound: {
        findMany: jest.fn()
      },
      mockLeaderboard: {
        findMany: jest.fn()
      },
      mockPlatformStat: {
        findFirst: jest.fn()
      }
    }
  };
});

import { prisma } from '../lib/prisma';

describe('MockDataRepository', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getRounds', () => {
    it('returns an array of MockRound on success', async () => {
      const roundsData = [
        { id: 'round-1', asset: 'BTC', mode: 'updown', status: 'live', startPrice: 60000, poolUp: 100, poolDown: 50, totalPool: null, predictionCount: null, closesAt: '2025-01-01T00:00:00Z' }
      ];
      (prisma.mockRound.findMany as jest.Mock).mockResolvedValue(roundsData);

      const result = await mockDataRepository.getRounds();
      expect(prisma.mockRound.findMany).toHaveBeenCalledTimes(1);
      expect(result).toEqual(roundsData);
    });

    it('throws when DB query fails', async () => {
      (prisma.mockRound.findMany as jest.Mock).mockRejectedValue(new Error('DB Error'));
      await expect(mockDataRepository.getRounds()).rejects.toThrow('DB Error');
    });
  });

  describe('getLeaderboard', () => {
    it('returns an array of MockLeaderboard sorted by rank', async () => {
      const lbData = [
        { address: 'ADDR1', rank: 1, totalWins: 10, totalLosses: 2, winStreak: 5, xp: 1000, rankTitle: 'Pro' }
      ];
      (prisma.mockLeaderboard.findMany as jest.Mock).mockResolvedValue(lbData);

      const result = await mockDataRepository.getLeaderboard();
      expect(prisma.mockLeaderboard.findMany).toHaveBeenCalledWith({ orderBy: { rank: 'asc' } });
      expect(result).toEqual(lbData);
    });

    it('throws when DB query fails', async () => {
      (prisma.mockLeaderboard.findMany as jest.Mock).mockRejectedValue(new Error('DB Error'));
      await expect(mockDataRepository.getLeaderboard()).rejects.toThrow('DB Error');
    });
  });

  describe('getPlatformStats', () => {
    it('returns a MockPlatformStat object on success', async () => {
      const statsData = { id: 1, totalRounds: 100, totalVxlmDistributed: 500, activePlayers: 10, totalBetsPlaced: 200 };
      (prisma.mockPlatformStat.findFirst as jest.Mock).mockResolvedValue(statsData);

      const result = await mockDataRepository.getPlatformStats();
      expect(prisma.mockPlatformStat.findFirst).toHaveBeenCalledTimes(1);
      expect(result).toEqual(statsData);
    });

    it('returns null if no stats exist', async () => {
      (prisma.mockPlatformStat.findFirst as jest.Mock).mockResolvedValue(null);
      const result = await mockDataRepository.getPlatformStats();
      expect(result).toBeNull();
    });

    it('throws when DB query fails', async () => {
      (prisma.mockPlatformStat.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));
      await expect(mockDataRepository.getPlatformStats()).rejects.toThrow('DB Error');
    });
  });
});
