import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";
import { Decimal } from "@prisma/client/runtime/library";

const MOCK_USER_ID = "serial-test-user";
const MOCK_WALLET = "GSERIAL_TEST_WALLET_ADDRESS________________";

const mockUserFindUnique = jest.fn();
const mockUserStatsFindUnique = jest.fn();
const mockRoundFindUnique = jest.fn();
const mockTransactionFindMany = jest.fn();
const mockTransactionCount = jest.fn();
const mockPredictionFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockNotificationFindMany = jest.fn();
const mockNotificationCount = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
    },
    userStats: {
      findUnique: (...args: any[]) => mockUserStatsFindUnique(...args),
    },
    round: {
      findUnique: (...args: any[]) => mockRoundFindUnique(...args),
    },
    prediction: {
      findMany: (...args: any[]) => mockPredictionFindMany(...args),
    },
    transaction: {
      findMany: (...args: any[]) => mockTransactionFindMany(...args),
      count: (...args: any[]) => mockTransactionCount(...args),
    },
    notification: {
      findMany: (...args: any[]) => mockNotificationFindMany(...args),
      count: (...args: any[]) => mockNotificationCount(...args),
    },
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
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("Monetary Field Serialization in API Responses", () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    app = createApp();
    token = generateToken(MOCK_USER_ID, MOCK_WALLET, "USER");
  });

  afterAll(async () => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockReset();
    mockUserStatsFindUnique.mockReset();
    mockRoundFindUnique.mockReset();
    mockTransactionFindMany.mockReset();
    mockTransactionCount.mockReset();
    mockPredictionFindMany.mockReset();
  });

  describe("user routes", () => {
    it("returns balance as decimal string, not $numberDecimal", async () => {
      const decimalBalance = new Decimal("1000.33333333");
      mockUserFindUnique.mockResolvedValue({
        id: MOCK_USER_ID,
        walletAddress: MOCK_WALLET,
        virtualBalance: decimalBalance,
      });

      const res = await request(app)
        .get("/api/user/balance")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.balance).toBe("string");
      expect(res.body.balance).toBe("1000.33333333");
      expect(res.body.balance).not.toContain("$numberDecimal");
    });

    it("returns profile balance as decimal string", async () => {
      const decimalBalance = new Decimal("42.00000001");
      mockUserFindUnique.mockResolvedValue({
        id: MOCK_USER_ID,
        walletAddress: MOCK_WALLET,
        nickname: "test",
        avatarUrl: null,
        preferences: null,
        streak: 5,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        virtualBalance: decimalBalance,
      });

      const res = await request(app)
        .get("/api/user/profile")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.profile.balance).toBe("string");
      expect(res.body.profile.balance).toBe("42.00000001");
    });

    it("returns user stats with decimal string earnings", async () => {
      const stats = {
        totalPredictions: 10,
        correctPredictions: 7,
        totalEarnings: new Decimal("99.12345678"),
        upDownWins: 4,
        upDownLosses: 3,
        upDownEarnings: new Decimal("60.50000000"),
        legendsWins: 3,
        legendsLosses: 0,
        legendsEarnings: new Decimal("38.62345678"),
      };
      mockUserStatsFindUnique.mockResolvedValue(stats);

      const res = await request(app)
        .get("/api/user/stats")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const s = res.body.stats;
      expect(typeof s.totalEarnings).toBe("string");
      expect(s.totalEarnings).toBe("99.12345678");
      expect(typeof s.upDownEarnings).toBe("string");
      expect(s.upDownEarnings).toBe("60.50000000");
      expect(typeof s.legendsEarnings).toBe("string");
      expect(s.legendsEarnings).toBe("38.62345678");
    });

    it("returns transaction amount as decimal string", async () => {
      mockTransactionFindMany.mockResolvedValue([
        {
          id: "tx-1",
          userId: MOCK_USER_ID,
          amount: new Decimal("500.00000001"),
          type: "WIN",
          description: "Round win",
          roundId: "round-1",
          createdAt: new Date(),
        },
      ]);
      mockTransactionCount.mockResolvedValue(1);

      const res = await request(app)
        .get("/api/user/transactions")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(typeof res.body.data[0].amount).toBe("string");
      expect(res.body.data[0].amount).toBe("500.00000001");
    });
  });

  describe("round routes", () => {
    it("serializes round monetary fields as strings", async () => {
      const round = {
        id: "round-1",
        mode: "UP_DOWN",
        status: "ACTIVE",
        startPrice: new Decimal("0.12345678"),
        endPrice: null,
        startTime: new Date(),
        endTime: new Date(),
        poolUp: new Decimal("100.10000000"),
        poolDown: new Decimal("50.05000000"),
        priceRanges: null,
        sorobanRoundId: null,
        isSoroban: false,
        predictions: [],
      };
      mockRoundFindUnique.mockResolvedValue(round);

      const res = await request(app)
        .get("/api/rounds/round-1")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const r = res.body.round;
      expect(typeof r.startPrice).toBe("string");
      expect(r.startPrice).toBe("0.12345678");
      expect(typeof r.poolUp).toBe("string");
      expect(r.poolUp).toBe("100.10000000");
      expect(typeof r.poolDown).toBe("string");
      expect(r.poolDown).toBe("50.05000000");
    });
  });

  describe("prediction routes", () => {
    it("serializes prediction amount and payout as strings", async () => {
      const prediction = {
        id: "pred-1",
        roundId: "round-1",
        userId: MOCK_USER_ID,
        amount: new Decimal("10.12345678"),
        side: "UP",
        priceRange: null,
        payout: new Decimal("15.50000000"),
        won: true,
        createdAt: new Date(),
        round: {
          id: "round-1",
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: new Decimal("100.00000000"),
          endPrice: new Decimal("105.00000000"),
        },
      };
      mockPredictionFindMany.mockResolvedValue([prediction]);

      const res = await request(app)
        .get("/api/predictions/user")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const p = res.body.predictions[0];
      expect(typeof p.amount).toBe("string");
      expect(p.amount).toBe("10.12345678");
      expect(typeof p.payout).toBe("string");
      expect(p.payout).toBe("15.50000000");
    });
  });

  describe("fractional edge cases", () => {
    it("does not produce float drift for 0.1 + 0.2 in serialized output", () => {
      const result = new Decimal("0.1").add(new Decimal("0.2"));
      expect(toDecimalString(result)).toBe("0.30000000");
      expect(toDecimalString(result)).not.toBe("0.30000000000000004");
    });

    it("preserves very small amounts (1 stroop equiv) in string form", () => {
      expect(toDecimalString("0.00000001")).toBe("0.00000001");
    });

    it("normalizes large fractional balances without precision loss", () => {
      const balance = new Decimal("999999.99999999");
      expect(toDecimalString(balance)).toBe("999999.99999999");
    });

    it("null-safe serialization returns null for nullable payout", () => {
      expect(toDecimalString(null)).toBeNull();
      expect(toDecimalString(undefined)).toBeNull();
    });

    it("repeated 0.1 arithmetic stays exact when serialized", () => {
      const tenTimes = Array.from({ length: 10 }, () => new Decimal("0.1"))
        .reduce((acc, d) => acc.add(d), new Decimal("0"));
      expect(toDecimalString(tenTimes)).toBe("1.00000000");
    });
  });
});
