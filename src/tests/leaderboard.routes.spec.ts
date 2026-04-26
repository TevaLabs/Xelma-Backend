import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";

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

    mockUserFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === user.id) {
        return Promise.resolve(user);
      }
      return Promise.resolve(null);
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return the leaderboard payload without authentication", async () => {
    mockUserStatsFindMany.mockImplementation(({ take, skip }: any) =>
      Promise.resolve(sampleStats.slice(skip, skip + take)),
    );
    mockUserStatsCount.mockImplementation((args: any) =>
      args?.where?.totalEarnings?.gt === 90 ? Promise.resolve(1) : Promise.resolve(3),
    );
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
    mockUserStatsCount.mockImplementation((args: any) =>
      args?.where?.totalEarnings?.gt === 90 ? Promise.resolve(1) : Promise.resolve(3),
    );

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
    expect(response.body.message).toContain("limit");
  });

  it("should reject invalid offset parameter", async () => {
    const response = await request(app).get("/api/leaderboard?offset=-1");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("ValidationError");
    expect(response.body.message).toContain("offset");
  });

  it("should return 500 when leaderboard service fails", async () => {
    mockUserStatsFindMany.mockRejectedValue(new Error("Database unavailable"));

    const response = await request(app).get("/api/leaderboard");

    expect(response.status).toBe(500);
    expect(response.body.message).toBe("Failed to fetch leaderboard");
    expect(response.body.error).toBe("AppError");
  });
});
