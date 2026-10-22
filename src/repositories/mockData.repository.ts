import { prisma } from '../lib/prisma';
import { MockRound, MockLeaderboard, MockPlatformStat } from '@prisma/client';

export class MockDataRepository {
  async getRounds(): Promise<MockRound[]> {
    return prisma.mockRound.findMany();
  }

  async getLeaderboard(): Promise<MockLeaderboard[]> {
    return prisma.mockLeaderboard.findMany({
      orderBy: { rank: 'asc' },
    });
  }

  async getPlatformStats(): Promise<MockPlatformStat | null> {
    const stats = await prisma.mockPlatformStat.findFirst();
    // Backward compatible: return the raw stats (Decimal will be serialized as string by Prisma)
    return stats;
  }
}

export const mockDataRepository = new MockDataRepository();
