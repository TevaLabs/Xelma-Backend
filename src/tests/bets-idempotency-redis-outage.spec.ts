/**
 * Redis-outage fail-closed test for bet-route idempotency (Issue #493).
 *
 * Simulates Redis being unreachable by pointing the shared client at a
 * closed port. The bet request MUST be rejected (503) and MUST NOT proceed:
 * no bet is recorded, no chain call happens, and no idempotency row is
 * written. This pins the fail-closed policy — there is no silent fallback to
 * DB-only locking on Redis failure.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  jest,
} from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { ErrorCode } from "../utils/errors";
import { createApp } from "../index";
import sorobanService from "../services/soroban.service";
import { generateToken } from "../utils/jwt.util";
import { prisma } from "../lib/prisma";
import { betStore } from "../data/bet-store";

// Point Redis at an unreachable address BEFORE the app is imported so every
// distributed-lock attempt fails. `REDIS_CONNECT_TIMEOUT_MS` keeps the
// refused connection fast.
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "300";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
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
  apiRateLimiter: (_req: any, _res: any, next: any) => next(),
  writeRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_ID = "outage-user-493";
const ENDPOINT = "/api/bets/up-down";
const IDEMPOTENCY_KEY = "outage-493-updown-0001";

describe("Bet idempotency fail-closed on Redis outage (#493)", () => {
  let app: Express;
  let token: string;

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Production-equivalent path: Prisma store + on-chain service. Redis is
    // unreachable, so the request must be rejected before any of this runs.
    process.env.DATA_STORE = "postgres";
    process.env.BET_STUB_MODE = "false";
    app = createApp();
    token = generateToken(USER_ID, VALID_ADDRESS, UserRole.USER);

    await prisma.idempotencyKey.deleteMany({ where: { userId: USER_ID } });
  });

  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { userId: USER_ID } });
    process.env = originalEnv;
  });

  it("rejects the bet with 503 when Redis is unreachable and records nothing", async () => {
    const betsBefore = betStore.getBets({ address: VALID_ADDRESS }).length;

    const res = await request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

    // Fail-closed: 503, not 200. The lock could not be acquired, so the bet
    // must not proceed — no silent fallback to DB-only locking.
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ErrorCode.EXTERNAL_SERVICE_ERROR);
    expect(res.body.message).toMatch(/lock/i);

    // Proof nothing happened: no bet, no chain call, no idempotency row.
    expect(betStore.getBets({ address: VALID_ADDRESS }).length - betsBefore).toBe(0);
    expect(sorobanService.placeBet).not.toHaveBeenCalled();

    const stored = await prisma.idempotencyKey.findUnique({
      where: {
        userId_endpoint_idempotencyKey: {
          userId: USER_ID,
          endpoint: ENDPOINT,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      },
    });
    expect(stored).toBeNull();
  });

  it("keeps failing closed on repeated attempts while Redis is down", async () => {
    const betsBefore = betStore.getBets({ address: VALID_ADDRESS }).length;

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app)
          .post(ENDPOINT)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", IDEMPOTENCY_KEY)
          .send({ address: VALID_ADDRESS, amount: 10, side: "UP" }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(503);
    }
    expect(betStore.getBets({ address: VALID_ADDRESS }).length - betsBefore).toBe(0);
    expect(sorobanService.placeBet).not.toHaveBeenCalled();
  });
});
