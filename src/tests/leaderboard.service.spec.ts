import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// ── Prisma mock ───────────────────────────────────────────────────────────────
jest.mock("../lib/prisma", () => {
  return {
    prisma: {
      userStats: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      round: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    },
  };
});

// ── Redis mock ────────────────────────────────────────────────────────────────
// All sorted-set helpers default to "unavailable" (null / no-op) so the
// existing DB-fallback tests continue to pass unchanged.  Individual tests
// that exercise the ZSET fast path override these mocks explicitly.
jest.mock("../lib/redis", () => ({
  getJsonFromCache: jest.fn().mockResolvedValue(null),
  setJsonToCache: jest.fn().mockResolvedValue(undefined),
  invalidateLeaderboardSortedSet: jest.fn().mockResolvedValue(undefined),
  zsetAdd: jest.fn().mockResolvedValue(undefined),
  zsetCard: jest.fn().mockResolvedValue(null),
  zsetRangeWithScores: jest.fn().mockResolvedValue(null),
  zsetRank: jest.fn().mockResolvedValue(null),
}));

import { prisma } from "../lib/prisma";
import * as redisLib from "../lib/redis";
import {
  getLeaderboard,
  getUserPosition,
  updateUserStatsForRound,
} from "../services/leaderboard.service";

const userStatsFindMany = prisma.userStats.findMany as unknown as jest.Mock;
const userStatsFindUnique = prisma.userStats.findUnique as unknown as jest.Mock;
const userStatsCount = prisma.userStats.count as unknown as jest.Mock;
const userStatsUpsert = prisma.userStats.upsert as unknown as jest.Mock;
const roundFindUnique = prisma.round.findUnique as unknown as jest.Mock;
const prismaTransaction = prisma.$transaction as unknown as jest.Mock;

const zsetRangeWithScoresMock = redisLib.zsetRangeWithScores as unknown as jest.Mock;
const zsetRankMock = redisLib.zsetRank as unknown as jest.Mock;
const zsetCardMock = redisLib.zsetCard as unknown as jest.Mock;
const zsetAddMock = redisLib.zsetAdd as unknown as jest.Mock;
const invalidateLeaderboardSortedSetMock =
  redisLib.invalidateLeaderboardSortedSet as unknown as jest.Mock;

const originalRedisCacheEnabled = process.env.REDIS_CACHE_ENABLED;

const sampleStats = [
  {
    userId: "u1",
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
    userId: "u2",
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
    userId: "u3",
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
    // Default: ZSET unavailable so all tests use the DB fallback unless overridden.
    zsetRangeWithScoresMock.mockResolvedValue(null);
    zsetRankMock.mockResolvedValue(null);
    zsetCardMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalRedisCacheEnabled === undefined) {
      delete process.env.REDIS_CACHE_ENABLED;
    } else {
      process.env.REDIS_CACHE_ENABLED = originalRedisCacheEnabled;
    }
  });

  // ── DB-fallback path (ZSET unavailable) ─────────────────────────────────────

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

  it("sorts leaderboard by total earnings and assigns sequential ranks (DB fallback)", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsCount.mockResolvedValue(3);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(3, 0, undefined);

    expect(result.leaderboard).toHaveLength(3);
    expect(result.leaderboard.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(result.leaderboard[0].userId).toBe("u1");
    expect(result.leaderboard[1].userId).toBe("u2");
    expect(result.leaderboard[2].userId).toBe("u3");
    expect(result.totalUsers).toBe(3);
  });

  it("includes authenticated user position in leaderboard response (DB fallback)", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsFindUnique.mockResolvedValue(sampleStats[1]);
    userStatsCount.mockImplementation((args: any) => {
      if (args?.where?.totalEarnings?.gt === 90) return Promise.resolve(1);
      return Promise.resolve(3);
    });

    const result = await getLeaderboard(3, 0, "u2");

    expect(result.userPosition).toBeDefined();
    expect(result.userPosition?.userId).toBe("u2");
    expect(result.userPosition?.rank).toBe(2);
    expect(result.userPosition?.totalEarnings).toBe("90.00000000");
  });

  it("returns undefined user position when the requested user is not found", async () => {
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsFindUnique.mockResolvedValue(null);
    userStatsCount.mockResolvedValue(3);

    const result = await getLeaderboard(3, 0, "unknown-user");

    expect(result.userPosition).toBeUndefined();
  });

  it("calculates user rank correctly when there are ties in earnings (DB fallback)", async () => {
    userStatsFindUnique.mockResolvedValue(sampleStats[2]);
    userStatsCount.mockImplementation((args: any) => {
      if (args?.where?.totalEarnings?.gt === 90) return Promise.resolve(1);
      return Promise.resolve(3);
    });

    const result = await getUserPosition("u3");

    expect(result).toBeDefined();
    expect(result?.rank).toBe(2);
    expect(result?.userId).toBe("u3");
    expect(result?.totalEarnings).toBe("90.00000000");
  });

  // ── ZSET fast path ──────────────────────────────────────────────────────────

  it("uses sorted-set range when ZSET is populated (fast path)", async () => {
    // Simulate a populated ZSET returning the top-2 members.
    zsetRangeWithScoresMock.mockResolvedValue([
      { value: "u1", score: 100 },
      { value: "u2", score: 90 },
    ]);
    zsetCardMock.mockResolvedValue(3);

    // findMany is called with an IN filter for the two userIds.
    userStatsFindMany.mockResolvedValue([sampleStats[0], sampleStats[1]]);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(2, 0, undefined);

    // Ranks come from ZSET order, not DB order.
    expect(result.leaderboard).toHaveLength(2);
    expect(result.leaderboard[0].rank).toBe(1);
    expect(result.leaderboard[0].userId).toBe("u1");
    expect(result.leaderboard[1].rank).toBe(2);
    expect(result.leaderboard[1].userId).toBe("u2");
    expect(result.totalUsers).toBe(3);

    // DB findMany should be called with IN filter, not a full scan.
    expect(userStatsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: ["u1", "u2"] } },
      }),
    );
    // DB count should NOT be called when ZSET cardinality is available.
    expect(userStatsCount).not.toHaveBeenCalled();
  });

  it("falls back to DB when ZSET returns empty array", async () => {
    zsetRangeWithScoresMock.mockResolvedValue([]);
    userStatsFindMany.mockResolvedValue(sampleStats);
    userStatsCount.mockResolvedValue(3);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(3, 0, undefined);

    // Should have fallen back to the full DB scan.
    expect(result.leaderboard).toHaveLength(3);
    expect(userStatsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { totalEarnings: "desc" } }),
    );
  });

  it("uses ZSET rank for getUserPosition fast path", async () => {
    // ZREVRANK returns 0-based index; rank 1 = index 0.
    zsetRankMock.mockResolvedValue(0);
    userStatsFindUnique.mockResolvedValue(sampleStats[0]);

    const result = await getUserPosition("u1");

    expect(result?.rank).toBe(1);
    // DB COUNT(*) should NOT be called.
    expect(userStatsCount).not.toHaveBeenCalled();
  });

  it("falls back to DB COUNT for getUserPosition when ZSET rank is null", async () => {
    zsetRankMock.mockResolvedValue(null);
    userStatsFindUnique.mockResolvedValue(sampleStats[1]);
    userStatsCount.mockResolvedValue(1); // 1 user has higher earnings

    const result = await getUserPosition("u2");

    expect(result?.rank).toBe(2);
    expect(userStatsCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { totalEarnings: { gt: sampleStats[1].totalEarnings } },
      }),
    );
  });

  it("uses DB COUNT for totalUsers when ZSET cardinality is null", async () => {
    zsetRangeWithScoresMock.mockResolvedValue([
      { value: "u1", score: 100 },
    ]);
    zsetCardMock.mockResolvedValue(null); // cardinality unavailable

    userStatsFindMany.mockResolvedValue([sampleStats[0]]);
    userStatsCount.mockResolvedValue(3);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(1, 0, undefined);

    expect(result.totalUsers).toBe(3);
    expect(userStatsCount).toHaveBeenCalledTimes(1);
  });

  it("respects offset when building ranks from ZSET", async () => {
    zsetRangeWithScoresMock.mockResolvedValue([
      { value: "u2", score: 90 },
      { value: "u3", score: 90 },
    ]);
    zsetCardMock.mockResolvedValue(3);
    userStatsFindMany.mockResolvedValue([sampleStats[1], sampleStats[2]]);
    userStatsFindUnique.mockResolvedValue(null);

    const result = await getLeaderboard(2, 1, undefined);

    expect(result.leaderboard[0].rank).toBe(2); // offset 1 → rank starts at 2
    expect(result.leaderboard[1].rank).toBe(3);
  });

  // ── updateUserStatsForRound ─────────────────────────────────────────────────

  it("updateUserStatsForRound writes to DB inside a transaction and syncs ZSET", async () => {
    const mockRound = {
      id: "round-1",
      mode: "UP_DOWN",
      startPrice: { gt: () => false },
      endPrice: { gt: (other: any) => true }, // price went up
      predictions: [
        {
          userId: "u1",
          side: "UP",
          amount: 10,
          priceRange: null,
          user: { id: "u1" },
        },
      ],
    };

    roundFindUnique.mockResolvedValue(mockRound);

    const upsertResult = {
      userId: "u1",
      totalEarnings: 110,
    };

    // $transaction executes the callback and returns the upsert result.
    prismaTransaction.mockImplementation(async (cb: any) => cb(prisma));
    userStatsUpsert.mockResolvedValue(upsertResult);

    await updateUserStatsForRound("round-1");

    expect(prismaTransaction).toHaveBeenCalledTimes(1);
    expect(userStatsUpsert).toHaveBeenCalledTimes(1);

    // Allow the fire-and-forget invalidation to settle.
    await new Promise((r) => setTimeout(r, 0));

    // ZSET is invalidated (not individually updated) so the next read rebuilds it.
    expect(zsetAddMock).not.toHaveBeenCalled();
    expect(invalidateLeaderboardSortedSetMock).toHaveBeenCalledTimes(1);
  });

  it("updateUserStatsForRound throws when round is not found", async () => {
    roundFindUnique.mockResolvedValue(null);

    await expect(updateUserStatsForRound("missing-round")).rejects.toThrow(
      "Round not found or not closed",
    );
  });

  it("updateUserStatsForRound throws when round has no endPrice", async () => {
    roundFindUnique.mockResolvedValue({
      id: "round-2",
      endPrice: null,
      predictions: [],
    });

    await expect(updateUserStatsForRound("round-2")).rejects.toThrow(
      "Round not found or not closed",
    );
  });
});
