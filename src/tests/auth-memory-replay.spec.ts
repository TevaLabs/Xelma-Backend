process.env.DATA_STORE = "memory";
process.env.DATA_MODE = "mock";
delete process.env.REDIS_URL;

import { describe, it, expect, beforeAll, afterAll, jest, beforeEach } from "@jest/globals";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

const mockVerifySignature = jest.fn();

jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address) && address.startsWith("G") && address.length === 56,
  verifySignature: (address: string, challenge: string, signature: string) =>
    mockVerifySignature(address, challenge, signature),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
    getTransactionStatus: jest.fn(),
    getUserPosition: jest.fn(),
  },
}));

jest.mock("../middleware/rateLimiter.middleware", () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
    apiRateLimiter: passthrough,
    writeRateLimiter: passthrough,
    betRateLimiter: passthrough,
    adminRoundRateLimiter: passthrough,
    oracleResolveRateLimiter: passthrough,
    chatMessageRateLimiter: passthrough,
    predictionRateLimiter: passthrough,
    batchPredictionRateLimiter: passthrough,
    batchLeaderboardRateLimiter: passthrough,
  };
});

describe("Auth challenge replay safety in memory mode (Issue 3)", () => {
  let app: import("express").Application;
  let prisma: typeof import("../lib/prisma").prisma;

  const originalEnv = { ...process.env };
  const WALLET = Keypair.random().publicKey();

  beforeAll(async () => {
    process.env.DATA_STORE = "memory";
    process.env.DATA_MODE = "mock";

    const { createApp } = await import("../app");
    app = createApp();

    ({ prisma } = await import("../lib/prisma"));
  });

  beforeEach(() => {
    mockVerifySignature.mockReset();
    mockVerifySignature.mockReturnValue(true);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("authenticates successfully on first use of a challenge", async () => {
    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: WALLET });

    expect(challengeRes.status).toBe(200);
    const challenge = challengeRes.body.challenge;
    expect(challenge).toBeDefined();

    const connectRes = await request(app)
      .post("/api/auth/connect")
      .send({
        walletAddress: WALLET,
        challenge,
        signature: "dummy-valid-signature",
      });

    expect(connectRes.status).toBe(200);
    expect(connectRes.body.token).toBeDefined();
  });

  it("rejects immediate replay of the consumed challenge with 401", async () => {
    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: WALLET });

    const challenge = challengeRes.body.challenge;

    // First use
    const firstRes = await request(app)
      .post("/api/auth/connect")
      .send({
        walletAddress: WALLET,
        challenge,
        signature: "dummy-signature-1",
      });
    expect(firstRes.status).toBe(200);

    // Replay attempt
    const replayRes = await request(app)
      .post("/api/auth/connect")
      .send({
        walletAddress: WALLET,
        challenge,
        signature: "dummy-signature-2",
      });

    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error).toMatch(/Authentication/);
  });

  it("rejects an expired challenge with 401", async () => {
    const expiredDate = new Date(Date.now() - 60_000); // 1 minute ago
    const challengeStr = `Xelma Authentication\nDomain: xelma.io\nAddress: ${WALLET}\nNonce: expired123`;

    await prisma.authChallenge.create({
      data: {
        walletAddress: WALLET,
        challenge: challengeStr,
        expiresAt: expiredDate,
        isUsed: false,
      },
    });

    const res = await request(app)
      .post("/api/auth/connect")
      .send({
        walletAddress: WALLET,
        challenge: challengeStr,
        signature: "dummy-signature",
      });

    expect(res.status).toBe(401);
  });

  it("enforces atomic one-time consumption under concurrent requests", async () => {
    const challengeRes = await request(app)
      .post("/api/auth/challenge")
      .send({ walletAddress: WALLET });

    const challenge = challengeRes.body.challenge;

    // Send 5 parallel connect requests with the same challenge
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post("/api/auth/connect")
          .send({
            walletAddress: WALLET,
            challenge,
            signature: "dummy-signature-concurrent",
          })
      )
    );

    const statuses = responses.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 200).length;
    const rejectedCount = statuses.filter((s) => s === 401).length;

    // Exactly one must succeed, all others must be rejected
    expect(successCount).toBe(1);
    expect(rejectedCount).toBe(4);
  });
});
