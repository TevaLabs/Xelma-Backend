import { describe, it, expect, beforeEach } from "@jest/globals";

import {
  getCacheMetrics,
  invalidateNamespace,
} from "../lib/redis";

jest.mock("../lib/prisma", () => {
  return {
    prisma: {
      userStats: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
    },
  };
});

import { prisma } from "../lib/prisma";
import { getLeaderboard } from "../services/leaderboard.service";

const sampleStats = [
  {
    user: { id: "u1", walletAddress: "G12345678901234567890" },
    totalEarnings: 100,
    totalPredictions: 10,
    correctPredictions: 6,
    upDownWins: 4,
    upDownLosses: 2,
    upDownEarnings: 60,
    legendsWins: 2,
    legendsLosses: 2,
    legendsEarnings: 40,
  },
  {
    user: { id: "u2", walletAddress: "G09876543210987654321" },
    totalEarnings: 50,
    totalPredictions: 5,
    correctPredictions: 2,
    upDownWins: 2,
    upDownLosses: 1,
    upDownEarnings: 25,
    legendsWins: 0,
    legendsLosses: 2,
    legendsEarnings: 25,
  },
];

const userStatsFindMany = prisma.userStats.findMany as unknown as jest.Mock;
const userStatsFindUnique = prisma.userStats.findUnique as unknown as jest.Mock;
const userStatsCount = prisma.userStats.count as unknown as jest.Mock;

describe("Leaderboard Redis cache", () => {
  const originalRedisCacheEnabled = process.env.REDIS_CACHE_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Redis disabled: bypasses cache and hits DB each request", async () => {
    // Force caching off regardless of local developer environment.
    process.env.REDIS_CACHE_ENABLED = "false";

    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsCount.mockResolvedValue(2);
    userStatsFindUnique.mockResolvedValue(null);

    const metricsBefore = getCacheMetrics();

    await getLeaderboard(2, 0, undefined);
    await getLeaderboard(2, 0, undefined);

    expect(userStatsFindMany).toHaveBeenCalledTimes(2);
    expect(userStatsCount).toHaveBeenCalledTimes(2);
    expect(userStatsFindUnique).toHaveBeenCalledTimes(0);

    const metricsAfter = getCacheMetrics();
    expect(metricsAfter.hits).toBe(metricsBefore.hits);
    expect(metricsAfter.bypasses).toBeGreaterThan(metricsBefore.bypasses);

    if (originalRedisCacheEnabled === undefined) {
      delete process.env.REDIS_CACHE_ENABLED;
    } else {
      process.env.REDIS_CACHE_ENABLED = originalRedisCacheEnabled;
    }
  });

  const runRedisHitMiss =
    process.env.REDIS_CACHE_TESTS === "true" && Boolean(process.env.REDIS_URL);

  (runRedisHitMiss ? it : it.skip)(
    "Redis enabled: second request served from cache (hit)",
    async () => {
      process.env.REDIS_CACHE_ENABLED = "true";

      userStatsFindMany.mockResolvedValue(sampleStats);
      userStatsCount.mockResolvedValue(2);

      // Make test deterministic by invalidating the namespace first.
      await invalidateNamespace("leaderboard");

      // Reset mocks after invalidation.
      jest.clearAllMocks();

      const metricsBefore = getCacheMetrics();

      await getLeaderboard(2, 0, undefined);
      await getLeaderboard(2, 0, undefined);

      expect(userStatsFindMany).toHaveBeenCalledTimes(1);
      expect(userStatsCount).toHaveBeenCalledTimes(1);

      const metricsAfter = getCacheMetrics();
      expect(metricsAfter.hits).toBeGreaterThan(metricsBefore.hits);

      if (originalRedisCacheEnabled === undefined) {
        delete process.env.REDIS_CACHE_ENABLED;
      } else {
        process.env.REDIS_CACHE_ENABLED = originalRedisCacheEnabled;
      }
    },
  );
});

