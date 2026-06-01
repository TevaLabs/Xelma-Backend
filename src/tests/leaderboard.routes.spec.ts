import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";
import { encodeCursor } from "../utils/pagination.util";

const mockUserFindUnique = jest.fn();
const mockUserStatsFindMany = jest.fn();
const mockUserStatsFindUnique = jest.fn();
const mockUserStatsCount = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    userStats: {
      findMany: (...args: any[]) => mockUserStatsFindMany(...args),
      findUnique: (...args: any[]) => mockUserStatsFindUnique(...args),
      count: (...args: any[]) => mockUserStatsCount(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const sampleStats = [
  {
    userId: "u1",
    user: { id: "u1", walletAddress: "GTEST_USER_1________________________" },
    totalEarnings: 100,
    totalPredictions: 10,
    correctPredictions: 8,
    upDownWins: 5,
    upDownLosses: 2,
    upDownEarnings: 60,
    legendsWins: 3,
    legendsLosses: 0,
    legendsEarnings: 40,
  },
  {
    userId: "u2",
    user: { id: "u2", walletAddress: "GTEST_USER_2________________________" },
    totalEarnings: 90,
    totalPredictions: 9,
    correctPredictions: 5,
    upDownWins: 4,
    upDownLosses: 1,
    upDownEarnings: 35,
    legendsWins: 1,
    legendsLosses: 3,
    legendsEarnings: 55,
  },
  {
    userId: "u3",
    user: { id: "u3", walletAddress: "GTEST_USER_3________________________" },
    totalEarnings: 90,
    totalPredictions: 7,
    correctPredictions: 3,
    upDownWins: 2,
    upDownLosses: 2,
    upDownEarnings: 20,
    legendsWins: 1,
    legendsLosses: 2,
    legendsEarnings: 70,
  },
];

describe("Leaderboard Routes", () => {
  let app: Express;
  let userToken: string;
  const user = {
    id: "u2",
    walletAddress: "GTEST_USER_2________________________",
    role: "USER",
  };

  beforeAll(() => {
    app = createApp();
    userToken = generateToken(user.id, user.walletAddress, UserRole.USER);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply the user mock after each clearAllMocks
    mockUserFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === user.id) {
        return Promise.resolve(user);
      }
      return Promise.resolve(null);
    });
  });

  // -------------------------------------------------------------------------
  // Existing offset-mode tests (preserved)
  // -------------------------------------------------------------------------

  it("should return the leaderboard payload without authentication", async () => {
    mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
      Promise.resolve(sampleStats.slice(skip, skip + take)),
    );
    // First call: global count for totalUsers (no where clause)
    // Second call: rank count for userPosition (has where.totalEarnings.gt)
    mockUserStatsCount.mockResolvedValue(3);
    mockUserStatsFindUnique.mockResolvedValue(null);

    const response = await request(app).get("/api/leaderboard");

    expect(response.status).toBe(200);
    expect(response.body.leaderboard).toHaveLength(3);
    expect(response.body.totalUsers).toBe(3);
    expect(response.body.userPosition).toBeUndefined();
    expect(response.body.lastUpdated).toBeDefined();
    expect(response.body.leaderboard[0].rank).toBe(1);
  });

  it("should include authenticated user position when token is provided", async () => {
    mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
      Promise.resolve(sampleStats.slice(skip, skip + take)),
    );
    mockUserStatsFindUnique.mockResolvedValue(sampleStats[1]);
    // getUserPosition calls count first (rank), then getLeaderboard calls count (totalUsers)
    mockUserStatsCount
      .mockResolvedValueOnce(1)   // rank: 1 user has higher earnings than u2 → rank=2
      .mockResolvedValueOnce(3);  // totalUsers

    const response = await request(app)
      .get("/api/leaderboard")
      .set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(200);
    expect(response.body.userPosition).toBeDefined();
    expect(response.body.userPosition.userId).toBe("u2");
    expect(response.body.userPosition.rank).toBe(2);
  });

  it("should respect pagination and return the correct offset slice", async () => {
    mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
      Promise.resolve(sampleStats.slice(skip, skip + take)),
    );
    mockUserStatsCount.mockResolvedValue(3);
    mockUserStatsFindUnique.mockResolvedValue(null);

    const response = await request(app).get("/api/leaderboard?limit=1&offset=1");

    expect(response.status).toBe(200);
    expect(response.body.leaderboard).toHaveLength(1);
    expect(response.body.leaderboard[0].userId).toBe("u2");
    expect(response.body.leaderboard[0].rank).toBe(2);
    expect(response.body.totalUsers).toBe(3);
  });

  it("should reject invalid limit parameter", async () => {
    const response = await request(app).get("/api/leaderboard?limit=1000");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("ValidationError");
    // Zod v4 message format: "Too big: expected number to be <=500"
    expect(response.body.details[0].field).toBe("limit");
  });

  it("should reject invalid offset parameter", async () => {
    const response = await request(app).get("/api/leaderboard?offset=-1");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("ValidationError");
    // Zod v4 message format: "Too small: expected number to be >=0"
    expect(response.body.details[0].field).toBe("offset");
  });

  it("should return 500 when leaderboard service fails", async () => {
    mockUserStatsFindMany.mockRejectedValue(new Error("Database unavailable"));

    const response = await request(app).get("/api/leaderboard");

    expect(response.status).toBe(500);
    expect(response.body.message).toBe("Failed to fetch leaderboard");
    expect(response.body.error).toBe("AppError");
  });

  // -------------------------------------------------------------------------
  // Pagination meta contract (Issue #19)
  // -------------------------------------------------------------------------

  describe("offset mode – pagination meta", () => {
    it("response includes pagination object with limit, offset, total, hasNextPage", async () => {
      mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
        Promise.resolve(sampleStats.slice(skip, skip + take)),
      );
      mockUserStatsCount.mockResolvedValue(3);
      mockUserStatsFindUnique.mockResolvedValue(null);

      const response = await request(app).get("/api/leaderboard?limit=2&offset=0");

      expect(response.status).toBe(200);
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.limit).toBe(2);
      expect(response.body.pagination.offset).toBe(0);
      expect(response.body.pagination.total).toBe(3);
      expect(response.body.pagination.hasNextPage).toBe(true);
    });

    it("hasNextPage is false on the last page", async () => {
      mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
        Promise.resolve(sampleStats.slice(skip, skip + take)),
      );
      mockUserStatsCount.mockResolvedValue(3);
      mockUserStatsFindUnique.mockResolvedValue(null);

      const response = await request(app).get("/api/leaderboard?limit=10&offset=0");

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasNextPage).toBe(false);
    });
  });

  describe("cursor mode", () => {
    it("returns pagination.nextCursor and hasNextPage=true when more rows exist", async () => {
      const moreStats = [...sampleStats, {
        userId: "u4",
        user: { id: "u4", walletAddress: "GTEST_USER_4________________________" },
        totalEarnings: 80,
        totalPredictions: 5,
        correctPredictions: 2,
        upDownWins: 1,
        upDownLosses: 2,
        upDownEarnings: 10,
        legendsWins: 1,
        legendsLosses: 1,
        legendsEarnings: 20,
      }];

      mockUserStatsFindMany.mockResolvedValue(moreStats); // 4 rows for limit=3
      mockUserStatsCount.mockResolvedValue(0); // rankOffset
      mockUserStatsFindUnique.mockResolvedValue(null);

      const cursor = encodeCursor({ totalEarnings: "100", userId: "u1" });
      const response = await request(app).get(`/api/leaderboard?limit=3&cursor=${cursor}`);

      expect(response.status).toBe(200);
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.hasNextPage).toBe(true);
      expect(typeof response.body.pagination.nextCursor).toBe("string");
      expect(response.body.totalUsers).toBeUndefined();
      expect(response.body.pagination.offset).toBeUndefined();
    });

    it("nextCursor is null on the last page", async () => {
      mockUserStatsFindMany.mockResolvedValue(sampleStats.slice(0, 2));
      mockUserStatsCount.mockResolvedValue(1); // rankOffset
      mockUserStatsFindUnique.mockResolvedValue(null);

      const cursor = encodeCursor({ totalEarnings: "100", userId: "u1" });
      const response = await request(app).get(`/api/leaderboard?limit=3&cursor=${cursor}`);

      expect(response.status).toBe(200);
      expect(response.body.pagination.hasNextPage).toBe(false);
      expect(response.body.pagination.nextCursor).toBeNull();
    });

    it("cursor mode ignores offset param", async () => {
      mockUserStatsFindMany.mockResolvedValue(sampleStats.slice(0, 2));
      mockUserStatsCount.mockResolvedValue(0);
      mockUserStatsFindUnique.mockResolvedValue(null);

      const cursor = encodeCursor({ totalEarnings: "100", userId: "u1" });
      const response = await request(app).get(
        `/api/leaderboard?limit=3&cursor=${cursor}&offset=99`,
      );

      expect(response.status).toBe(200);
      expect(response.body.pagination.offset).toBeUndefined();
    });
  });
});
