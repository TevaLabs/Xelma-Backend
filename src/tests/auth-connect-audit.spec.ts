/**
 * Issue #968 — failed `/api/auth/connect` attempts must be audited.
 *
 * The challenge-lifecycle event (failed/expired/reused/invalid signature) is
 * emitted as before; this suite pins the additional aggregate AUTH_FAILED event
 * and asserts the audit payload never carries the challenge or signature.
 */
import request from "supertest";
import { Express } from "express";
import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { createApp } from "../index";
import { auditLogger } from "../utils/audit-logger";
import * as stellarService from "../services/stellar.service";

jest.mock("../middleware/rateLimiter.middleware", () => {
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
    chatMessageRateLimiter: passthrough,
    predictionRateLimiter: passthrough,
    adminRoundRateLimiter: passthrough,
    oracleResolveRateLimiter: passthrough,
    betRateLimiter: passthrough,
    batchPredictionRateLimiter: passthrough,
    batchLeaderboardRateLimiter: passthrough,
  };
});

jest.mock("../utils/audit-logger", () => ({
  auditLogger: {
    logChallengeIssued: jest.fn(),
    logChallengeVerified: jest.fn(),
    logChallengeFailed: jest.fn(),
    logChallengeExpired: jest.fn(),
    logChallengeReused: jest.fn(),
    logChallengeInvalidated: jest.fn(),
    logInvalidSignature: jest.fn(),
    logAuthFailed: jest.fn(),
    logAuthSuccess: jest.fn(),
    logUserCreated: jest.fn(),
    logUserLogin: jest.fn(),
  },
}));

jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn(),
  isValidStellarAddress: jest.fn(),
}));

const mockVerifySignature = stellarService.verifySignature as jest.MockedFunction<
  typeof stellarService.verifySignature
>;
const mockIsValidStellarAddress = stellarService.isValidStellarAddress as jest.MockedFunction<
  typeof stellarService.isValidStellarAddress
>;

const logAuthFailed = auditLogger.logAuthFailed as unknown as jest.Mock;
const logChallengeExpired = auditLogger.logChallengeExpired as unknown as jest.Mock;
const logInvalidSignature = auditLogger.logInvalidSignature as unknown as jest.Mock;

const mockAuthChallengeFindUnique = jest.fn();
const mockAuthChallengeUpdateMany = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    authChallenge: {
      findUnique: (...args: any[]) => mockAuthChallengeFindUnique(...args),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: (...args: any[]) => mockAuthChallengeUpdateMany(...args),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    transaction: {
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const WALLET = "GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN";
const CHALLENGE = "xelma_auth_audit_secret_challenge_value";
const SIGNATURE = "super-secret-signature-value";

describe("POST /api/auth/connect audit logging (#968)", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsValidStellarAddress.mockReturnValue(true);
    mockVerifySignature.mockResolvedValue(true);
  });

  function expectNoSecretsInAuditPayload(): void {
    const serialized = JSON.stringify(logAuthFailed.mock.calls);
    expect(serialized).not.toContain(CHALLENGE);
    expect(serialized).not.toContain(SIGNATURE);
  }

  it("records AUTH_FAILED when the challenge is expired", async () => {
    mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockAuthChallengeFindUnique.mockResolvedValueOnce({
      id: "ch-expired",
      challenge: CHALLENGE,
      walletAddress: WALLET,
      expiresAt: new Date(Date.now() - 60_000),
      isUsed: false,
      createdAt: new Date(Date.now() - 120_000),
    });

    const res = await request(app)
      .post("/api/auth/connect")
      .send({ walletAddress: WALLET, challenge: CHALLENGE, signature: SIGNATURE });

    expect(res.status).toBe(401);
    expect(logChallengeExpired).toHaveBeenCalledTimes(1);
    expect(logAuthFailed).toHaveBeenCalledTimes(1);
    expect(logAuthFailed.mock.calls[0][0]).toMatchObject({
      walletAddress: WALLET,
      reason: "challenge_expired",
    });
    expectNoSecretsInAuditPayload();
  });

  it("records AUTH_FAILED when the challenge is unknown", async () => {
    mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockAuthChallengeFindUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/auth/connect")
      .send({ walletAddress: WALLET, challenge: CHALLENGE, signature: SIGNATURE });

    expect(res.status).toBe(401);
    expect(logAuthFailed).toHaveBeenCalledTimes(1);
    expect(logAuthFailed.mock.calls[0][0]).toMatchObject({
      walletAddress: WALLET,
      reason: "challenge_not_found",
    });
    expectNoSecretsInAuditPayload();
  });

  it("records AUTH_FAILED when the signature is invalid", async () => {
    mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockVerifySignature.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/auth/connect")
      .send({ walletAddress: WALLET, challenge: CHALLENGE, signature: SIGNATURE });

    expect(res.status).toBe(401);
    expect(logInvalidSignature).toHaveBeenCalledTimes(1);
    expect(logAuthFailed).toHaveBeenCalledTimes(1);
    expect(logAuthFailed.mock.calls[0][0]).toMatchObject({
      walletAddress: WALLET,
      reason: "invalid_signature",
    });
    expectNoSecretsInAuditPayload();
  });

  it("records AUTH_FAILED when a challenge is reused", async () => {
    mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockAuthChallengeFindUnique.mockResolvedValueOnce({
      id: "ch-used",
      challenge: CHALLENGE,
      walletAddress: WALLET,
      expiresAt: new Date(Date.now() + 60_000),
      isUsed: true,
      usedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .post("/api/auth/connect")
      .send({ walletAddress: WALLET, challenge: CHALLENGE, signature: SIGNATURE });

    expect(res.status).toBe(401);
    expect(logAuthFailed).toHaveBeenCalledTimes(1);
    expect(logAuthFailed.mock.calls[0][0]).toMatchObject({
      walletAddress: WALLET,
      reason: "challenge_used",
    });
    expectNoSecretsInAuditPayload();
  });
});
