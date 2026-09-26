import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../app-factory";
import { generateToken } from "../utils/jwt.util";

const USER_ID = "user-profile-test-id";
const OTHER_USER_ID = "other-user-id";
const WALLET = "GPROFILE_TEST_USER_WALLET_ADDRESS__________";

const mockUserFindUnique = jest.fn();
const mockUserFindFirst = jest.fn();
const mockUserUpdate = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      findFirst: (...args: any[]) => mockUserFindFirst(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
    transaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    userStats: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
  apiRateLimiter: (_req: any, _res: any, next: any) => next(),
  writeRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("Unique Nickname with 409 Conflict Envelope (Issue #690)", () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    app = createApp();
    token = generateToken(USER_ID, WALLET, UserRole.USER);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ id: USER_ID, walletAddress: WALLET, role: UserRole.USER });
  });

  it("returns 409 Conflict when nickname is already taken by another user", async () => {
    mockUserFindFirst.mockResolvedValue({
      id: OTHER_USER_ID,
      nickname: "taken_nickname",
    });

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "taken_nickname" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/nickname is already taken/i);
    expect(res.body).toHaveProperty("code", "CONFLICT");
    expect(res.body).toHaveProperty("timestamp");
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("handles Prisma P2002 unique constraint violation as 409 Conflict", async () => {
    mockUserFindFirst.mockResolvedValue(null);
    const p2002Error: any = new Error("Unique constraint failed on the fields: (`nickname`)");
    p2002Error.code = "P2002";
    mockUserUpdate.mockRejectedValue(p2002Error);

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "concurrent_nick" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/nickname is already taken/i);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("allows setting an available nickname", async () => {
    mockUserFindFirst.mockResolvedValue(null);
    mockUserUpdate.mockResolvedValue({
      nickname: "unique_nick",
      avatarUrl: null,
      preferences: null,
    });

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "unique_nick" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.profile.nickname).toBe("unique_nick");
  });
});
