/**
 * Real concurrency tests for the Redis-backed distributed idempotency lock
 * (Issue #493).
 *
 * These tests require a real PostgreSQL (Prisma store) and a real Redis:
 *   - locally: `docker compose up -d postgres redis` (see docker-compose.yml)
 *   - CI: the `test-integration` job spins up both services (ci.yml)
 *
 * They simulate multiple API replicas by racing many concurrent HTTP requests
 * carrying the SAME `Idempotency-Key` against the same app, which is exactly
 * the multi-replica race the distributed lock must serialize. The assertions
 * prove single logical acceptance: exactly one bet is created and every other
 * response replays the stored DB result.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import sorobanService from "../services/soroban.service";
import { generateToken } from "../utils/jwt.util";
import { prisma } from "../lib/prisma";
import { betStore } from "../data/bet-store";
import { closeRedisClient } from "../lib/redis";

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

// Integration tests talk to a real Redis (localhost by default; overridden by
// the CI job env). The distributed lock must never silently fall back.
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = "redis://localhost:6379";
}

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_ID = "concurrency-user-493";
const ENDPOINT = "/api/bets/up-down";
const IDEMPOTENCY_KEY = "conc-493-updown-0001";

describe("Bet idempotency under concurrent multi-replica load (#493)", () => {
  let app: Express;
  let token: string;

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Force the production-equivalent path: Prisma store + on-chain service.
    process.env.DATA_STORE = "postgres";
    process.env.BET_STUB_MODE = "false";
    app = createApp();
    token = generateToken(USER_ID, VALID_ADDRESS, UserRole.USER);

    await prisma.idempotencyKey.deleteMany({ where: { userId: USER_ID } });
  });

  beforeEach(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { userId: USER_ID } });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { userId: USER_ID } });
    await closeRedisClient();
    process.env = originalEnv;
  });

  const placeUpDownBet = (payload: Record<string, unknown>) =>
    request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(payload);

  it("accepts exactly one logical bet when many 'replicas' race the same Idempotency-Key", async () => {
    (sorobanService.placeBet as jest.Mock).mockImplementation(async () => {
      // Widen the processing window so all 12 requests genuinely contend on
      // the Redis lock instead of finishing before the losers start.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { state: "on-chain-success", txHash: "0xconcurrent-lock-493" };
    });

    const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };
    const betsBefore = betStore.getBets({ address: VALID_ADDRESS }).length;

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => placeUpDownBet(payload)),
    );

    // Every request must succeed and replay the SAME logical result.
    for (const res of responses) {
      expect(res.status).toBe(200);
      // `toEqual` (not string equality): the replayed body is read back from
      // Postgres jsonb, which may reorder keys vs. the live response.
      expect(res.body).toEqual(responses[0].body);
    }

    // Exactly one bet was accepted, and the chain service ran exactly once.
    expect(betStore.getBets({ address: VALID_ADDRESS }).length - betsBefore).toBe(1);
    expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);

    // The final response is persisted in the DB so legitimate retries replay.
    const stored = await prisma.idempotencyKey.findUnique({
      where: {
        userId_endpoint_idempotencyKey: {
          userId: USER_ID,
          endpoint: ENDPOINT,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      },
    });
    expect(stored).not.toBeNull();
    expect(stored?.responseStatus).toBe(200);
    expect(stored?.responseBody).toEqual(responses[0].body);
  });

  it("replays the stored DB response on a sequential retry without re-executing", async () => {
    (sorobanService.placeBet as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      txHash: "0xreplay-493",
    });
    const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };
    const betsBefore = betStore.getBets({ address: VALID_ADDRESS }).length;

    const first = await placeUpDownBet(payload);
    expect(first.status).toBe(200);

    const second = await placeUpDownBet(payload);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // No duplicate bet, no second chain submission.
    expect(betStore.getBets({ address: VALID_ADDRESS }).length - betsBefore).toBe(1);
    expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);
  });

  it("still rejects a mutated payload reusing the same Idempotency-Key", async () => {
    (sorobanService.placeBet as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      txHash: "0xmutated-493",
    });

    const first = await placeUpDownBet({
      address: VALID_ADDRESS,
      amount: 10,
      side: "UP",
    });
    expect(first.status).toBe(200);

    const mutated = await placeUpDownBet({
      address: VALID_ADDRESS,
      amount: 20,
      side: "UP",
    });
    expect(mutated.status).toBe(409);
    expect(mutated.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);
  });
});
