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
    return prisma.mockPlatformStat.findFirst();
  }
}

export const mockDataRepository = new MockDataRepository();
