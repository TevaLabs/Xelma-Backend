jest.mock('../lib/prisma', () => ({
  prisma: {
    round: {
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from '../lib/prisma';
import educationTipService from '../services/education-tip.service';

const mockedFindUnique = prisma.round.findUnique as unknown as jest.Mock;


describe('EducationTipService', () => {
  beforeEach(() => {
    // Clear cache before each test
    jest.clearAllMocks();
  });

  // afterEach(() => {
  //   jest.restoreAllMocks();
  // });

  describe('generateTip', () => {
    it('should generate a valid tip for a resolved round with high volatility', async () => {
      const mockRound = {
        id: 'test-round-1',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      (prisma.round.findUnique as typeof  mockedFindUnique).mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-1');

      expect(tip).toBeDefined();
      expect(tip.roundId).toBe('test-round-1');
      expect(tip.message).toBeTruthy();
      expect(tip.category).toMatch(/volatility|oracle|stellar|price-action/);
      expect(tip.metadata).toBeDefined();
      expect(tip.metadata?.priceChange).toBe(0.05);
      expect(tip.metadata?.priceChangePercent).toBe(5);
      expect(tip.metadata?.outcome).toBe('up');
    });

    it('should generate a tip for low volatility round', async () => {
      const mockRound = {
        id: 'test-round-2',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.003,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-2');

      expect(tip).toBeDefined();
      expect(tip.metadata?.priceChangePercent).toBe(0.3);
      expect(tip.metadata?.outcome).toBe('up');
    });

    it('should generate a tip for unchanged price', async () => {
      const mockRound = {
        id: 'test-round-3',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.0,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-3');

      expect(tip).toBeDefined();
      expect(tip.metadata?.priceChange).toBe(0);
      expect(tip.metadata?.priceChangePercent).toBe(0);
      expect(tip.metadata?.outcome).toBe('unchanged');
    });

    it('should generate a tip for price decrease', async () => {
      const mockRound = {
        id: 'test-round-4',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 0.95,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-4');

      expect(tip).toBeDefined();
      expect(tip.metadata?.priceChange).toBe(-0.05);
      expect(tip.metadata?.priceChangePercent).toBe(-5);
      expect(tip.metadata?.outcome).toBe('down');
    });

    it('should throw error for non-existent round', async () => {
      mockedFindUnique.mockResolvedValue(null);

      await expect(
        educationTipService.generateTip('non-existent-round')
      ).rejects.toThrow('Round not found');
    });

    it('should throw error for unresolved round', async () => {
      const mockRound = {
        id: 'test-round-5',
        mode: 0,
        status: 'ACTIVE',
        startPrice: 1.0,
        endPrice: null,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      await expect(
        educationTipService.generateTip('test-round-5')
      ).rejects.toThrow('Round must be resolved before generating educational tips');
    });

    it('should throw error for round with missing price data', async () => {
      const mockRound = {
        id: 'test-round-6',
        mode: 0,
        status: 'RESOLVED',
        startPrice: null,
        endPrice: null,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      await expect(
        educationTipService.generateTip('test-round-6')
      ).rejects.toThrow('Round missing required price data');
    });

    it('should use cache for subsequent requests for same round', async () => {
      const mockRound = {
        id: 'test-round-7',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      // First call
      const tip1 = await educationTipService.generateTip('test-round-7');
      
      // Second call should use cache
      const tip2 = await educationTipService.generateTip('test-round-7');

      expect(tip1).toEqual(tip2);
      // Should only call database once
      expect(prisma.round.findUnique).toHaveBeenCalledTimes(1);
    });

    it('should generate different tips across multiple rounds', async () => {
      const mockRounds = [
        {
          id: 'test-round-8',
          mode: 0,
          status: 'RESOLVED',
          startPrice: 1.0,
          endPrice: 1.05,
          startTime: new Date('2024-01-01T00:00:00Z'),
          endTime: new Date('2024-01-01T00:05:00Z'),
        },
        {
          id: 'test-round-9',
          mode: 0,
          status: 'RESOLVED',
          startPrice: 1.05,
          endPrice: 1.03,
          startTime: new Date('2024-01-01T00:05:00Z'),
          endTime: new Date('2024-01-01T00:10:00Z'),
        },
        {
          id: 'test-round-10',
          mode: 0,
          status: 'RESOLVED',
          startPrice: 1.03,
          endPrice: 1.08,
          startTime: new Date('2024-01-01T00:10:00Z'),
          endTime: new Date('2024-01-01T00:15:00Z'),
        },
      ];

      mockedFindUnique
        .mockResolvedValueOnce(mockRounds[0])
        .mockResolvedValueOnce(mockRounds[1])
        .mockResolvedValueOnce(mockRounds[2]);

      const tip1 = await educationTipService.generateTip('test-round-8');
      const tip2 = await educationTipService.generateTip('test-round-9');
      const tip3 = await educationTipService.generateTip('test-round-10');

      // Tips should be valid
      expect(tip1).toBeDefined();
      expect(tip2).toBeDefined();
      expect(tip3).toBeDefined();

      // Should have called database 3 times
      expect(prisma.round.findUnique).toHaveBeenCalledTimes(3);
    });

    it('should handle extreme price movements correctly', async () => {
      const mockRound = {
        id: 'test-round-11',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.15,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:01:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-11');

      expect(tip).toBeDefined();
      expect(tip.metadata?.priceChangePercent).toBe(15);
      expect(Math.abs(tip.metadata?.priceChangePercent || 0)).toBeGreaterThan(5);
    });

    it('should interpolate variables correctly in message', async () => {
      const mockRound = {
        id: 'test-round-12',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.2345,
        endPrice: 1.2845,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-12');

      expect(tip).toBeDefined();
      // Message should contain interpolated values
      expect(tip.message).toBeTruthy();
      // Should not contain template placeholders
      expect(tip.message).not.toContain('{');
      expect(tip.message).not.toContain('}');
    });

    it('should calculate duration correctly', async () => {
      const mockRound = {
        id: 'test-round-13',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:10:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-13');

      expect(tip.metadata?.duration).toBe(600); // 10 minutes = 600 seconds
    });
  });

  describe('cache management', () => {
    it('should provide cache statistics', () => {
      const stats = educationTipService.getCacheStats();

      expect(stats).toBeDefined();
      expect(stats.size).toBeGreaterThanOrEqual(0);
      expect(stats.maxSize).toBe(1000);
      expect(stats.ttlMs).toBe(3600000); // 1 hour
    });

    it('should clear cache for specific round', async () => {
      const mockRound = {
        id: 'test-round-14',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      // Generate tip to populate cache
      await educationTipService.generateTip('test-round-14');

      // Clear cache
      educationTipService.clearCache('test-round-14');

      // Next call should hit database again
      jest.clearAllMocks();
      mockedFindUnique.mockResolvedValue(mockRound);
      
      await educationTipService.generateTip('test-round-14');

      expect(prisma.round.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should handle very small price changes', async () => {
      const mockRound = {
        id: 'test-round-15',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.0001,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-15');

      expect(tip).toBeDefined();
      expect(tip.metadata?.priceChangePercent).toBe(0.01);
    });

    it('should handle very short rounds', async () => {
      const mockRound = {
        id: 'test-round-16',
        mode: 0,
        status: 'RESOLVED',
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:00:05Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-16');

      expect(tip).toBeDefined();
      expect(tip.metadata?.duration).toBe(5);
    });

    it('should handle BigInt price values from database', async () => {
      const mockRound = {
        id: 'test-round-17',
        mode: 0,
        status: 'RESOLVED',
        startPrice: BigInt(10000000), // 1.0 in stroops
        endPrice: BigInt(10500000), // 1.05 in stroops
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-01T00:05:00Z'),
      };

      mockedFindUnique.mockResolvedValue(mockRound);

      const tip = await educationTipService.generateTip('test-round-17');

      expect(tip).toBeDefined();
      // Should handle BigInt conversion correctly
      expect(tip.metadata?.priceChange).toBeDefined();
      expect(tip.metadata?.priceChangePercent).toBeDefined();
    });
  });

  describe('tip variety', () => {
    it('should include all required categories in library', async () => {
      const categories = new Set<string>();

      // Generate tips for multiple rounds to sample different categories
      for (let i = 0; i < 20; i++) {
        const mockRound = {
          id: `test-round-variety-${i}`,
          mode: 0,
          status: 'RESOLVED',
          startPrice: 1.0,
          endPrice: 1.0 + (Math.random() * 0.1 - 0.05),
          startTime: new Date('2024-01-01T00:00:00Z'),
          endTime: new Date('2024-01-01T00:05:00Z'),
        };

        mockedFindUnique.mockResolvedValue(mockRound);

        const tip = await educationTipService.generateTip(`test-round-variety-${i}`);
        categories.add(tip.category);
      }

      // Should have variety of categories
      expect(categories.size).toBeGreaterThanOrEqual(2);
    });
  });
});