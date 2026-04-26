import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

jest.mock("../lib/prisma", () => {
  return {
    prisma: {
      userStats: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      $disconnect: jest.fn().mockResolvedValue(undefined),
    },
  };
});

import { prisma } from "../lib/prisma";
import { getLeaderboard, getUserPosition } from "../services/leaderboard.service";

const userStatsFindMany = prisma.userStats.findMany as unknown as jest.Mock;
const userStatsFindUnique = prisma.userStats.findUnique as unknown as jest.Mock;
const userStatsCount = prisma.userStats.count as unknown as jest.Mock;

const originalRedisCacheEnabled = process.env.REDIS_CACHE_ENABLED;

const sampleStats = [
  {
    user: { id: "u1", walletAddress: "GTEST_USER_1________________________" },
    totalEarnings: 100,
    totalPredictions: 10,
    correctPredictions: 7,
    upDownWins: 4,
    upDownLosses: 3,
    upDownEarnings: 60,
    legendsWins: 3,
    legendsLosses: 0,
    legendsEarnings: 40,
  },
  {
    user: { id: "u2", walletAddress: "GTEST_USER_2________________________" },
    totalEarnings: 90,
    totalPredictions: 8,
    correctPredictions: 4,
    upDownWins: 2,
    upDownLosses: 2,
    upDownEarnings: 30,
    legendsWins: 2,
    legendsLosses: 2,
    legendsEarnings: 60,
  },
  {
    user: { id: "u3", walletAddress: "GTEST_USER_3________________________" },
    totalEarnings: 90,
    totalPredictions: 6,
    correctPredictions: 3,
    upDownWins: 1,
    upDownLosses: 1,
    upDownEarnings: 10,
    legendsWins: 2,
    legendsLosses: 2,
    legendsEarnings: 80,
  },
];

describe("Leaderboard Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_CACHE_ENABLED = "false";
  });

  afterEach(() => {
    if (originalRedisCacheEnabled === undefined) {
      delete process.env.REDIS_CACHE_ENABLED;
    } else {
      process.env.REDIS_CACHE_ENABLED = originalRedisCacheEnabled;
    }
  });

  it("returns an empty leaderboard when no user stats exist", async () => {
    userStatsFindMany.mockResolvedValue([]);
    userStatsCount.mockResolvedValue(0);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(100, 0, undefined);

    expect(result.leaderboard).toEqual([]);
    expect(result.totalUsers).toBe(0);
    expect(result.userPosition).toBeUndefined();
    expect(result.lastUpdated).toBeDefined();
  });

  it("sorts leaderboard by total earnings and assigns sequential ranks", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsCount.mockResolvedValue(3);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(3, 0, undefined);

    expect(result.leaderboard).toHaveLength(3);
    expect(result.leaderboard.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(result.leaderboard[0].userId).toBe("u1");
    expect(result.leaderboard[1].userId).toBe("u2");
    expect(result.leaderboard[2].userId).toBe("u3");
    expect(result.totalUsers).toBe(3);
  });

  it("includes authenticated user position in leaderboard response", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsFindUnique.mockResolvedValue(sampleStats[1]);
    userStatsCount.mockImplementation((args: any) => {
      if (args?.where?.totalEarnings?.gt === 90) {
        return Promise.resolve(1);
      }
      return Promise.resolve(3);
    });

    const result = await getLeaderboard(3, 0, "u2");

    expect(result.userPosition).toBeDefined();
    expect(result.userPosition?.userId).toBe("u2");
    expect(result.userPosition?.rank).toBe(2);
    expect(result.userPosition?.totalEarnings).toBe(90);
  });

  it("returns undefined user position when the requested user is not found", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsFindUnique.mockResolvedValue(null);
    userStatsCount.mockResolvedValue(3);

    const result = await getLeaderboard(3, 0, "unknown-user");

    expect(result.userPosition).toBeUndefined();
  });

  it("calculates user rank correctly when there are ties in earnings", async () => {
    userStatsFindUnique.mockResolvedValue(sampleStats[2]);
    userStatsCount.mockImplementation((args: any) => {
      if (args?.where?.totalEarnings?.gt === 90) {
        return Promise.resolve(1);
      }
      return Promise.resolve(3);
    });

    const result = await getUserPosition("u3");

    expect(result).toBeDefined();
    expect(result?.rank).toBe(2);
    expect(result?.userId).toBe("u3");
    expect(result?.totalEarnings).toBe(90);
  });
});
