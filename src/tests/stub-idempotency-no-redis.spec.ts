
/**
 * Stub-mode idempotency without Redis (Issue #374).
 *
 * Proves that memory-mode bet idempotency works end-to-end without Redis:
 *
 * 1. A keyed bet returns 200 (not 503) when DATA_STORE=memory and REDIS_URL
 *    is unset — the distributed Redis lock is skipped.
 * 2. A duplicate identical key replays the cached response.
 * 3. Parallel same-key requests execute the bet exactly once.
 * 4. BET_STUB_MODE=true + DATA_STORE=postgres + REDIS_URL requires Redis.
 */

// Ensure memory mode and no Redis BEFORE any imports.
process.env.DATA_STORE = "memory";
process.env.BET_STUB_MODE = "true";
delete process.env.REDIS_URL;

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  jest,
  beforeEach,
} from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { generateToken } from "../utils/jwt.util";
import { resetInMemoryIdempotencyStore } from "../utils/idempotency.util";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock("../middleware/rateLimiter.middleware", () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    apiRateLimiter: passthrough,
    writeRateLimiter: passthrough,
    betRateLimiter: passthrough,
    adminRoundRateLimiter: passthrough,
    oracleResolveRateLimiter: passthrough,
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
    chatMessageRateLimiter: passthrough,
    predictionRateLimiter: passthrough,
    batchPredictionRateLimiter: passthrough,
    batchLeaderboardRateLimiter: passthrough,
  };
});

const VALID_ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const USER_ID = "stub-idemp-no-redis-user";
const ENDPOINT = "/api/bets/up-down";

describe("Stub-mode idempotency without Redis (#374)", () => {
  let app: Express;
  let token: string;

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Dynamic import so env is set before module resolution.
    const { createApp } = await import("../app");
    app = createApp();
    token = generateToken(USER_ID, VALID_ADDRESS, UserRole.USER);
  });

  beforeEach(() => {
    resetInMemoryIdempotencyStore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns 200 for a keyed bet (not 503) when DATA_STORE=memory and no REDIS_URL", async () => {
    const key = "memory-no-redis-001";
    const res = await request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

    // Must succeed — no Redis requirement in memory mode.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("replays the cached response on duplicate key", async () => {
    const key = "memory-no-redis-replay-002";
    const body = { address: VALID_ADDRESS, amount: 25, side: "DOWN" };

    const first = await request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(200);

    const second = await request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("executes the bet exactly once under concurrent duplicate requests", async () => {
    const key = "memory-no-redis-concurrency-003";
    const body = { address: VALID_ADDRESS, amount: 5, side: "UP" };

    // Bets flow through BetService (backed by the memory Prisma client in this
    // mode), so count executions at the service boundary rather than in the
    // legacy betStore, which the current bet path no longer writes to.
    const { default: betService } = await import("../services/bet.service");
    const recordSpy = jest.spyOn(betService, "recordUpDownBet");

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(ENDPOINT)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key)
          .send(body),
      ),
    );

    // All should return 200 (either original or replayed).
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);

    // The underlying bet should have been placed exactly once.
    expect(recordSpy).toHaveBeenCalledTimes(1);

    recordSpy.mockRestore();
  });
});

describe("BET_STUB_MODE=true + DATA_STORE=postgres + REDIS_URL must use Redis lock", () => {
  let app: Express;
  let token: string;

  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // Production-like: Prisma store + configured (but unreachable) Redis.
    process.env.DATA_STORE = "postgres";
    process.env.BET_STUB_MODE = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.REDIS_CONNECT_TIMEOUT_MS = "300";

    const { createApp } = await import("../index");
    app = createApp();
    token = generateToken("stub-redis-required-user", VALID_ADDRESS, UserRole.USER);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects with 503 when REDIS_URL is configured but unreachable, even in BET_STUB_MODE", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "stub-redis-required-001")
      .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

    // Fail-closed: 503 because Redis is configured but unreachable.
    // BET_STUB_MODE alone does NOT bypass the distributed lock.
    expect(res.status).toBe(503);
  });
});
