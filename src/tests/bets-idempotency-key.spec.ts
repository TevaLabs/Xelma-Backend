/**
 * Idempotency-Key support for the bet endpoints, built on the shared
 * idempotency util + model (`runIdempotent` / `readIdempotencyKey`).
 *
 * Runs against the in-memory idempotency store (DATA_STORE=memory) with a
 * stubbed Redis lock client, so no database or Redis instance is required.
 */
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import betService from "../services/bet.service";
import { generateToken } from "../utils/jwt.util";
import {
  IDEMPOTENT_REPLAYED_HEADER,
  readIdempotencyKey,
  resetInMemoryIdempotencyStore,
  runIdempotent,
} from "../utils/idempotency.util";
import * as distributedLock from "../utils/distributed-idempotency-lock";
import { ConflictError, ExternalServiceError, ValidationError } from "../utils/errors";
import { getConnectedRedisClient } from "../lib/redis";
import { prisma } from "../lib/prisma";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock("../middleware/rateLimiter.middleware", () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    challengeRateLimiter: pass,
    connectRateLimiter: pass,
    authRateLimiter: pass,
    chatMessageRateLimiter: pass,
    predictionRateLimiter: pass,
    batchPredictionRateLimiter: pass,
    batchLeaderboardRateLimiter: pass,
    adminRoundRateLimiter: pass,
    oracleResolveRateLimiter: pass,
    apiRateLimiter: pass,
    writeRateLimiter: pass,
    betRateLimiter: pass,
  };
});

jest.mock("../lib/redis", () => {
  const actual = jest.requireActual("../lib/redis");
  return { ...actual, getConnectedRedisClient: jest.fn() };
});

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("readIdempotencyKey", () => {
  it("returns undefined when the header is missing or blank", () => {
    expect(readIdempotencyKey({})).toBeUndefined();
    expect(readIdempotencyKey({ "idempotency-key": "" })).toBeUndefined();
    expect(readIdempotencyKey({ "idempotency-key": "   " })).toBeUndefined();
  });

  it("returns the trimmed key", () => {
    expect(readIdempotencyKey({ "idempotency-key": "  abc-12345  " })).toBe("abc-12345");
  });

  it("joins repeated headers so they fail key validation instead of picking one", () => {
    expect(readIdempotencyKey({ "idempotency-key": ["key-aaaaaaa", "key-bbbbbbb"] })).toBe(
      "key-aaaaaaa,key-bbbbbbb",
    );
  });
});

describe("runIdempotent", () => {
  beforeAll(() => {
    (getConnectedRedisClient as jest.Mock).mockResolvedValue({
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    });
  });

  beforeEach(() => {
    process.env.DATA_STORE = "memory";
  });

  afterEach(() => {
    resetInMemoryIdempotencyStore();
  });

  const base = { userId: "user-1", endpoint: "/api/test", requestBody: { a: 1 } };

  it("runs the operation every time when no key is supplied", async () => {
    const operation = jest.fn(async () => ({ status: 200, body: { ok: true } }));

    await runIdempotent({ ...base, idempotencyKey: undefined, operation });
    const second = await runIdempotent({ ...base, idempotencyKey: undefined, operation });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(second.replayed).toBe(false);
  });

  it("replays the stored response for a repeated key + body", async () => {
    let n = 0;
    const operation = jest.fn(async () => ({ status: 201, body: { n: ++n } }));

    const first = await runIdempotent({ ...base, idempotencyKey: "key-replay-1", operation });
    const second = await runIdempotent({ ...base, idempotencyKey: "key-replay-1", operation });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: 201, body: { n: 1 }, replayed: false });
    expect(second).toEqual({ status: 201, body: { n: 1 }, replayed: true });
  });

  it("rejects an invalid key format without running the operation", async () => {
    const operation = jest.fn(async () => ({ status: 200, body: {} }));

    await expect(
      runIdempotent({ ...base, idempotencyKey: "bad key!", operation }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects key reuse with a different body as a conflict", async () => {
    const operation = jest.fn(async () => ({ status: 200, body: {} }));

    await runIdempotent({ ...base, idempotencyKey: "key-conflict-1", operation });
    await expect(
      runIdempotent({
        ...base,
        requestBody: { a: 2 },
        idempotencyKey: "key-conflict-1",
        operation,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("releases the key when the operation fails so the client can retry", async () => {
    const operation = jest
      .fn<() => Promise<{ status: number; body: { ok: boolean } }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: 200, body: { ok: true } });

    await expect(
      runIdempotent({ ...base, idempotencyKey: "key-retry-1", operation }),
    ).rejects.toThrow("boom");

    const retry = await runIdempotent({ ...base, idempotencyKey: "key-retry-1", operation });
    expect(retry).toEqual({ status: 200, body: { ok: true }, replayed: false });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("fails closed with 503 when the distributed lock is unavailable", async () => {
    const spy = jest
      .spyOn(distributedLock, "withDistributedIdempotencyLock")
      .mockRejectedValueOnce(new distributedLock.DistributedIdempotencyLockUnavailableError());
    const operation = jest.fn(async () => ({ status: 200, body: {} }));

    try {
      await expect(
        runIdempotent({ ...base, idempotencyKey: "key-noredis-1", operation }),
      ).rejects.toBeInstanceOf(ExternalServiceError);
      expect(operation).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the key locked when storing the result fails after the side effect", async () => {
    const storeSpy = jest
      .spyOn(prisma.idempotencyKey, "upsert")
      .mockRejectedValueOnce(new Error("db down") as never);
    const prevStub = process.env.BET_STUB_MODE;
    process.env.DATA_STORE = "postgres";
    process.env.BET_STUB_MODE = "false";
    const findSpy = jest.spyOn(prisma.idempotencyKey, "findUnique").mockResolvedValue(null as never);
    const createSpy = jest.spyOn(prisma.idempotencyKey, "create").mockResolvedValue({} as never);
    const releaseSpy = jest
      .spyOn(prisma.idempotencyKey, "deleteMany")
      .mockResolvedValue({ count: 1 } as never);
    const lockSpy = jest
      .spyOn(distributedLock, "withDistributedIdempotencyLock")
      .mockImplementation(async (_u, _e, _k, fn) => fn());
    const operation = jest.fn(async () => ({ status: 200, body: { claimed: true } }));

    try {
      await expect(
        runIdempotent({ ...base, idempotencyKey: "key-store-fail", operation }),
      ).rejects.toBeInstanceOf(ExternalServiceError);
      expect(operation).toHaveBeenCalledTimes(1);
      // The pending row must NOT be released: releasing it would let a retry
      // perform the (already executed) side effect a second time.
      expect(releaseSpy).not.toHaveBeenCalled();
    } finally {
      [storeSpy, findSpy, createSpy, releaseSpy, lockSpy].forEach((s) => s.mockRestore());
      if (prevStub === undefined) delete process.env.BET_STUB_MODE;
      else process.env.BET_STUB_MODE = prevStub;
    }
  });
});

describe("Bet routes honour Idempotency-Key", () => {
  let app: Express;
  let token: string;
  const originalEnv = process.env;

  beforeAll(() => {
    (getConnectedRedisClient as jest.Mock).mockResolvedValue({
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    });
    app = createApp();
    token = generateToken("user-1", VALID_ADDRESS, UserRole.USER);
  });

  beforeEach(() => {
    process.env = { ...originalEnv, DATA_STORE: "memory", BET_STUB_MODE: "true" };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    resetInMemoryIdempotencyStore();
  });

  it("marks replayed up-down responses with Idempotent-Replayed", async () => {
    // Bet persistence is covered by the DB-backed bets.routes integration
    // suite; here we only exercise the idempotency layer around it.
    const placeSpy = jest
      .spyOn(betService, "recordUpDownBet")
      .mockResolvedValue({ state: "stub", betId: "bet-updown-1", status: "ACCEPTED" } as any);
    const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };
    const send = () =>
      request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "route-updown-replay")
        .send(payload);

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(placeSpy).toHaveBeenCalledTimes(1);
  });

  it("marks replayed precision responses with Idempotent-Replayed", async () => {
    const placeSpy = jest
      .spyOn(betService, "recordPrecisionBet")
      .mockResolvedValue({ state: "stub", betId: "bet-precision-1", status: "ACCEPTED" } as any);
    const payload = { address: VALID_ADDRESS, amount: 10, predictedPrice: 0.1234 };
    const send = () =>
      request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "route-precision-replay")
        .send(payload);

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(placeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed Idempotency-Key on bets with 400", async () => {
    const res = await request(app)
      .post("/api/bets/up-down")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "short")
      .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

    expect(res.status).toBe(400);
  });

  describe("POST /api/bets/claim", () => {
    it("claims once and replays the original response for the same key", async () => {
      const claimSpy = jest.spyOn(betService, "claimWinnings");
      const send = () =>
        request(app)
          .post("/api/bets/claim")
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", "route-claim-replay")
          .send({});

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ success: true, state: "stub" });
      expect(second.status).toBe(200);
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
      expect(second.body).toEqual(first.body);
      expect(claimSpy).toHaveBeenCalledTimes(1);
    });

    it("claims every time when no key is supplied", async () => {
      const claimSpy = jest.spyOn(betService, "claimWinnings");

      await request(app).post("/api/bets/claim").set("Authorization", `Bearer ${token}`).send({});
      await request(app).post("/api/bets/claim").set("Authorization", `Bearer ${token}`).send({});

      expect(claimSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects a malformed Idempotency-Key with 400 and does not claim", async () => {
      const claimSpy = jest.spyOn(betService, "claimWinnings");

      const res = await request(app)
        .post("/api/bets/claim")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "not valid!")
        .send({});

      expect(res.status).toBe(400);
      expect(claimSpy).not.toHaveBeenCalled();
    });
  });
});
