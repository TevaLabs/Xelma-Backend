import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Application } from "express";
import { UserRole } from "@prisma/client";

// Mocks must be hoisted before module imports.
// These prevent app.ts from pulling in real stellar/chain dependencies.
jest.mock("@stellar/stellar-sdk", () => ({}));
jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: jest.fn().mockReturnValue(true),
}));
jest.mock("../services/soroban.service", () => ({
  default: {
    getUserStats: jest.fn().mockResolvedValue(null),
    getPendingWinnings: jest.fn().mockResolvedValue("0"),
  },
}));

import { createApp } from "../app";
import { generateToken } from "../utils/jwt.util";

// ---------------------------------------------------------------------------
// Tournament routes use hardcoded mock data — no Prisma dependency.
// Tests validate the canonical pagination shape.
// ---------------------------------------------------------------------------

describe("GET /api/tournaments — pagination meta", () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  it("returns pagination with limit, offset, total, hasNextPage", async () => {
    const res = await request(app).get("/api/tournaments?limit=1&offset=0");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination).toEqual({
      limit: 1,
      offset: 0,
      total: 3,
      hasNextPage: true,
    });
  });

  it("hasNextPage is false on the last page", async () => {
    const res = await request(app).get("/api/tournaments?limit=10&offset=0");

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
  });

  it("hasNextPage is false when offset exceeds total", async () => {
    const res = await request(app).get("/api/tournaments?limit=5&offset=100");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.hasNextPage).toBe(false);
  });

  it("paginated response has data array and pagination object at top level", async () => {
    const res = await request(app).get("/api/tournaments?limit=2&offset=0");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.limit).toBe(2);
    expect(res.body.pagination.offset).toBe(0);
    expect(res.body.pagination.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// User endpoints require mocked Prisma
// ---------------------------------------------------------------------------

const mockUserFindUnique = jest.fn();
const mockTransactionFindMany = jest.fn();
const mockTransactionCount = jest.fn();
const mockPredictionFindMany = jest.fn();
const mockPredictionCount = jest.fn();
const mockUserStatsFindUnique = jest.fn();
const mock$transaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => ({}));
jest.mock("../services/stellar.service", () => ({ default: {} }));
jest.mock("../services/soroban.service", () => ({
  default: {
    getUserStats: jest.fn().mockResolvedValue(null),
    getPendingWinnings: jest.fn().mockResolvedValue("0"),
  },
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    transaction: {
      findMany: (...args: any[]) => mockTransactionFindMany(...args),
      count: (...args: any[]) => mockTransactionCount(...args),
    },
    prediction: {
      findMany: (...args: any[]) => mockPredictionFindMany(...args),
      count: (...args: any[]) => mockPredictionCount(...args),
    },
    userStats: {
      findUnique: (...args: any[]) => mockUserStatsFindUnique(...args),
    },
    $transaction: (...args: any[]) => mock$transaction(...args),
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
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

const USER_ID = "pagination-test-user";
const WALLET = "GXXXX_PAGINATION_TEST_WALLET_______________";

describe("GET /api/user/transactions — pagination meta", () => {
  let app: Application;
  let token: string;

  beforeAll(() => {
    app = createApp();
    token = generateToken(USER_ID, WALLET, UserRole.USER);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ id: USER_ID, walletAddress: WALLET });
    mockTransactionFindMany.mockResolvedValue([]);
    mockTransactionCount.mockResolvedValue(25);
    mock$transaction.mockImplementation((queries: any[]) =>
      Promise.resolve(queries.map((q: any) => {
        if (q === mockTransactionFindMany) return mockTransactionFindMany();
        if (q === mockTransactionCount) return mockTransactionCount();
        return [];
      })),
    );
  });

  it("returns offset pagination with limit, offset, total, hasNextPage", async () => {
    mock$transaction.mockResolvedValue([[], 25]);

    const res = await request(app)
      .get("/api/user/transactions?limit=10&offset=0")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination).toEqual({
      limit: 10,
      offset: 0,
      total: 25,
      hasNextPage: true,
    });
  });

  it("hasNextPage is false on the last page", async () => {
    mock$transaction.mockResolvedValue([[], 25]);

    const res = await request(app)
      .get("/api/user/transactions?limit=50&offset=0")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
  });

  it("validates limit range", async () => {
    const res = await request(app)
      .get("/api/user/transactions?limit=0")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/user/:address/history — pagination meta", () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns offset pagination with limit, offset, total, hasNextPage", async () => {
    mockUserFindUnique.mockResolvedValue({ id: USER_ID });
    mock$transaction.mockResolvedValue([[], 10]);

    const res = await request(app).get(`/api/user/${WALLET}/history?limit=5&offset=0`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination).toEqual({
      limit: 5,
      offset: 0,
      total: 10,
      hasNextPage: true,
    });
  });

  it("returns cursor pagination with limit, nextCursor, hasNextPage", async () => {
    mockUserFindUnique.mockResolvedValue({ id: USER_ID });

    const now = new Date();
    const predictions = Array.from({ length: 6 }, (_, i) => ({
      id: `p-${i}`,
      roundId: `r-${i}`,
      userId: USER_ID,
      amount: "10",
      side: "UP",
      priceRange: null,
      won: null,
      payout: null,
      createdAt: new Date(now.getTime() - i * 1000),
      round: {
        id: `r-${i}`,
        mode: "UP_DOWN",
        startPrice: "0.5",
        endPrice: null,
        status: "OPEN",
        startTime: new Date(),
        endTime: new Date(),
        resolvedAt: null,
      },
    }));

    mockPredictionFindMany.mockResolvedValue(predictions);

    const cursor = Buffer.from(now.toISOString()).toString("base64url");
    const res = await request(app).get(`/api/user/${WALLET}/history?limit=5&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.limit).toBe(5);
    expect(typeof res.body.pagination.nextCursor).toBe("string");
    expect(res.body.pagination.hasNextPage).toBe(true);
    expect(res.body.pagination.offset).toBeUndefined();
  });

  it("nextCursor is null on the last page", async () => {
    mockUserFindUnique.mockResolvedValue({ id: USER_ID });

    const predictions = Array.from({ length: 3 }, (_, i) => ({
      id: `p-${i}`,
      roundId: `r-${i}`,
      userId: USER_ID,
      amount: "10",
      side: "UP",
      priceRange: null,
      won: null,
      payout: null,
      createdAt: new Date(Date.now() - i * 1000),
      round: {
        id: `r-${i}`,
        mode: "UP_DOWN",
        startPrice: "0.5",
        endPrice: null,
        status: "OPEN",
        startTime: new Date(),
        endTime: new Date(),
        resolvedAt: null,
      },
    }));

    mockPredictionFindMany.mockResolvedValue(predictions);

    const cursor = Buffer.from(new Date().toISOString()).toString("base64url");
    const res = await request(app).get(`/api/user/${WALLET}/history?limit=5&cursor=${cursor}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.nextCursor).toBeNull();
  });

  it("returns empty pagination for unknown address", async () => {
    mockUserFindUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/user/UNKNOWN_ADDRESS/history?limit=10&offset=0");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toEqual({
      limit: 10,
      offset: 0,
      total: 0,
      hasNextPage: false,
    });
  });
});
