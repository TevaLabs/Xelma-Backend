import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";

// Mock external services to keep performance tests focused on backend logic
jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn().mockResolvedValue(true),
  isValidStellarAddress: jest.fn().mockReturnValue(true),
}));

// Mock rate limiters to avoid 429 during tests
jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Mock Prisma to keep tests lightweight and avoid DB dependency
jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: "perf-user-id", walletAddress: "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX", role: "USER" }),
    },
    authChallenge: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: "ch-1", challenge: "xelma_auth_perf", expiresAt: new Date() }),
    },
    round: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: "some-uuid", status: "ACTIVE", mode: "UP_DOWN" }),
    },
    prediction: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((cb) => cb({
      round: { 
        findUnique: jest.fn().mockResolvedValue({ id: "some-uuid", status: "ACTIVE", mode: "UP_DOWN" }),
        update: jest.fn().mockResolvedValue({}),
      },
      prediction: { 
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "pred-1" }),
      },
      user: { 
        findUnique: jest.fn().mockResolvedValue({ id: "perf-user-id", walletAddress: "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX", role: "USER", virtualBalance: 1000 }),
        update: jest.fn().mockResolvedValue({ id: "perf-user-id", walletAddress: "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX", role: "USER", virtualBalance: 990 }),
      },
    })),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("Performance Baseline Checks (#152)", () => {
  let app: Express;
  let validToken: string;
  const WALLET = "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";

  beforeAll(() => {
    app = createApp();
    validToken = generateToken("perf-user-id", WALLET, UserRole.USER);
  });

  const measureLatency = async (
    method: "get" | "post",
    path: string,
    body?: any,
    token?: string
  ): Promise<number> => {
    const start = Date.now();
    const req = request(app)[method](path);
    if (token) req.set("Authorization", `Bearer ${token}`);
    if (body) req.send(body);
    await req;
    return Date.now() - start;
  };

  /**
   * BASELINE THRESHOLDS (ms)
   * These are intended for a typical CI environment. 
   * Adjust these if the environment is significantly slower/faster.
   */
  const THRESHOLDS = {
    CHALLENGE_LATENCY: 200,
    ACTIVE_ROUNDS_LATENCY: 150,
    SUBMIT_PREDICTION_LATENCY: 300,
  };

  it(`POST /api/auth/challenge should respond within ${THRESHOLDS.CHALLENGE_LATENCY}ms`, async () => {
    const latency = await measureLatency("post", "/api/auth/challenge", {
      walletAddress: WALLET,
    });
    console.log(`[PERF] /api/auth/challenge latency: ${latency}ms`);
    expect(latency).toBeLessThan(THRESHOLDS.CHALLENGE_LATENCY);
  });

  it(`GET /api/rounds/active should respond within ${THRESHOLDS.ACTIVE_ROUNDS_LATENCY}ms`, async () => {
    const latency = await measureLatency("get", "/api/rounds/active");
    console.log(`[PERF] /api/rounds/active latency: ${latency}ms`);
    expect(latency).toBeLessThan(THRESHOLDS.ACTIVE_ROUNDS_LATENCY);
  });

  it(`POST /api/predictions/submit should respond within ${THRESHOLDS.SUBMIT_PREDICTION_LATENCY}ms`, async () => {
    // Note: This test might hit database or service logic. 
    // In a real environment, this might be slower due to DB IO.
    const latency = await measureLatency(
      "post",
      "/api/predictions/submit",
      {
        roundId: "some-uuid",
        amount: 10,
        side: "UP",
      },
      validToken
    );
    console.log(`[PERF] /api/predictions/submit latency: ${latency}ms`);
    // We don't necessarily expect success (round might not exist), 
    // but the latency check remains valid for the request-response cycle.
    expect(latency).toBeLessThan(THRESHOLDS.SUBMIT_PREDICTION_LATENCY);
  });
});
