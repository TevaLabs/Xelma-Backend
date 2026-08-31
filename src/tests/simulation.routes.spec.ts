/**
 * Route-level tests for POST /api/rounds/:id/simulate (Issue #553).
 *
 * Verifies the ENABLE_SIMULATION master-switch behavior (403 in EVERY
 * environment when the flag is off, not just production) and the ADMIN
 * bearer-token requirement when the flag is on.
 *
 * Uses a mocked config module so the flag can be flipped between requests,
 * and a mocked simulation service so no database is required.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import { UserRole } from "@prisma/client";
import { Express } from "express";
import { generateToken } from "../utils/jwt.util";

const ADMIN_ID = "sim-admin-id";
const USER_ID = "sim-user-id";

const mockUserFindUnique = jest.fn();
const mockSimulateRound = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/simulation.service", () => ({
  __esModule: true,
  default: { simulateRound: (...args: any[]) => mockSimulateRound(...args) },
}));

jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

/**
 * Mutable config state shared with the mocked ../config module below.
 * Re-registered via jest.resetModules() so a fresh config is built for
 * each enableSimulation scenario.
 */
const mockConfigState = { enableSimulation: false };

jest.mock("../config", () => ({
  __esModule: true,
  default: {
    app: {
      port: 3000,
      nodeEnv: "test",
      clientUrl: "*",
      logLevel: "info",
      apiOnly: false,
      roundsMockMode: false,
      dataMode: "mock",
      dataStore: "postgres",
      enableSimulation: mockConfigState.enableSimulation,
      enableMultiplayerSocial: false,
    },
    jwt: {
      secret: "test-jwt-secret-for-mock",
      expiry: "7d",
    },
    database: {
      url: "postgresql://mock:mock@localhost:5432/mock",
      connectionLimit: 10,
      poolTimeoutSeconds: 10,
      connectTimeoutSeconds: 10,
      statementTimeoutMs: 0,
      pgbouncer: false,
    },
    soroban: {
      contractId: "",
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      adminSecret: "",
      oracleSecret: "",
    },
    scheduler: {
      autoResolveEnabled: false,
      autoResolveIntervalSeconds: 30,
      roundSchedulerEnabled: false,
      roundSchedulerMode: "UP_DOWN",
    },
    stellar: { network: "testnet" },
    socket: { clientUrl: "*" },
    oracle: {
      pollingIntervalMs: 10000,
      requestTimeoutMs: 5000,
      maxRetries: 3,
      stalenessThresholdMs: 60000,
      coinGeckoUrl: "",
      coinCapUrl: "",
    },
  },
}));

function makeSimulationResult(overrides: Record<string, unknown> = {}) {
  return {
    roundId: "round-sim-1",
    simulatedPrice: 55000,
    mode: "UP_DOWN",
    startPrice: 50000,
    winningSide: "UP",
    winningRange: null,
    predictions: [
      { won: true, payout: 180, amount: 100, side: "UP" },
      { won: false, payout: 0, amount: 150, side: "DOWN" },
    ],
    summary: {
      totalPredictions: 2,
      winners: 1,
      losers: 1,
      refunded: 0,
      totalPayout: 180,
    },
    ...overrides,
  };
}

describe("POST /api/rounds/:id/simulate - ENABLE_SIMULATION flag and auth (Issue #553)", () => {
  let app: Express;
  let adminToken: string;
  let userToken: string;

  beforeAll(() => {
    adminToken = generateToken(ADMIN_ID, "GADMIN_SIM_TEST_AAAAAAAAAAAAAAAAA", UserRole.ADMIN);
    userToken = generateToken(USER_ID, "GUSER_SIM_TEST_AAAAAAAAAAAAAAAAAAAA", UserRole.USER);
  });

  async function buildApp(enableSimulation: boolean): Promise<Express> {
    mockConfigState.enableSimulation = enableSimulation;
    jest.resetModules();
    const { createApp } = require("../index");
    return createApp();
  }

  describe("flag OFF (ENABLE_SIMULATION=false) - locked down in every environment", () => {
    it("returns 403 in a non-production environment (nodeEnv=test) without calling the service", async () => {
      app = await buildApp(false);
      mockSimulateRound.mockResolvedValue(makeSimulationResult());

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/ENABLE_SIMULATION=true/);
      expect(mockSimulateRound).not.toHaveBeenCalled();
    });

    it("returns 403 even with a valid ADMIN token - the flag gate runs before auth", async () => {
      app = await buildApp(false);
      mockUserFindUnique.mockResolvedValue({
        id: ADMIN_ID,
        walletAddress: "GADMIN_SIM_TEST_AAAAAAAAAAAAAAAAA",
        role: "ADMIN",
      });

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(mockSimulateRound).not.toHaveBeenCalled();
    });
  });

  describe("flag ON (ENABLE_SIMULATION=true) - admin-only", () => {
    it("returns 401 without a bearer token", async () => {
      app = await buildApp(true);

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(401);
      expect(mockSimulateRound).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin (USER role) bearer token", async () => {
      app = await buildApp(true);
      mockUserFindUnique.mockResolvedValue({
        id: USER_ID,
        walletAddress: "GUSER_SIM_TEST_AAAAAAAAAAAAAAAAAAAA",
        role: "USER",
      });

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(403);
      expect(mockSimulateRound).not.toHaveBeenCalled();
    });

    it("returns 200 with the simulation result for an ADMIN", async () => {
      app = await buildApp(true);
      mockUserFindUnique.mockResolvedValue({
        id: ADMIN_ID,
        walletAddress: "GADMIN_SIM_TEST_AAAAAAAAAAAAAAAAA",
        role: "ADMIN",
      });
      mockSimulateRound.mockResolvedValue(makeSimulationResult());

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.roundId).toBe("round-sim-1");
      expect(res.body.mode).toBe("UP_DOWN");
      expect(res.body.winningSide).toBe("UP");
      expect(res.body.predictions).toHaveLength(2);
      expect(res.body.summary).toMatchObject({
        totalPredictions: 2,
        winners: 1,
        losers: 1,
      });
      expect(mockSimulateRound).toHaveBeenCalledWith("round-sim-1", 55000);
    });

    it("returns 400 when finalPrice is missing", async () => {
      app = await buildApp(true);
      mockUserFindUnique.mockResolvedValue({
        id: ADMIN_ID,
        walletAddress: "GADMIN_SIM_TEST_AAAAAAAAAAAAAAAAA",
        role: "ADMIN",
      });

      const res = await request(app)
        .post("/api/rounds/round-sim-1/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/finalPrice is required/);
      expect(mockSimulateRound).not.toHaveBeenCalled();
    });

    it("returns 404 when the round does not exist", async () => {
      app = await buildApp(true);
      mockUserFindUnique.mockResolvedValue({
        id: ADMIN_ID,
        walletAddress: "GADMIN_SIM_TEST_AAAAAAAAAAAAAAAAA",
        role: "ADMIN",
      });
      mockSimulateRound.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/rounds/missing-round/simulate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ finalPrice: 55000 });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Round not found/);
    });
  });
});
