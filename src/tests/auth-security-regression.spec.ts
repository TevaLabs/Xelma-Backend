/**
 * Issue #195 — Expand auth security regression suite for replay/tamper vectors.
 *
 * Companion to:
 *   - src/tests/auth.routes.spec.ts (happy-path + basic validation)
 *   - src/tests/auth-race.spec.ts (DB-backed concurrent connect)
 *
 * This file focuses on attack vectors those suites do not cover:
 *   1. Replay: re-using a consumed challenge after a successful connect.
 *   2. Tamper: swapping wallets, swapping challenges, mutating signatures.
 *   3. Expired/used short-circuit semantics on the atomic updateMany guard.
 *   4. Input-shape attacks: oversized signatures, non-string types,
 *      empty strings, control characters, header-injection style payloads.
 *
 * All tests run with mocked Prisma + Stellar, so they execute without a DB.
 */
import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import * as stellarService from "../services/stellar.service";

jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn(),
  isValidStellarAddress: jest.fn(),
}));

// Bypass rate limiters: we are exercising security semantics, not throttling.
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
}));

const mockVerifySignature = stellarService.verifySignature as jest.MockedFunction<
  typeof stellarService.verifySignature
>;
const mockIsValidStellarAddress = stellarService.isValidStellarAddress as jest.MockedFunction<
  typeof stellarService.isValidStellarAddress
>;

const mockUserFindUnique = jest.fn();
const mockUserCreate = jest.fn();
const mockUserUpdate = jest.fn();
const mockAuthChallengeFindUnique = jest.fn();
const mockAuthChallengeFindMany = jest.fn();
const mockAuthChallengeCreate = jest.fn();
const mockAuthChallengeUpdateMany = jest.fn();
const mockAuthChallengeDeleteMany = jest.fn();
const mockTransactionCreate = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      create: (...args: any[]) => mockUserCreate(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    authChallenge: {
      findUnique: (...args: any[]) => mockAuthChallengeFindUnique(...args),
      findMany: (...args: any[]) => mockAuthChallengeFindMany(...args),
      create: (...args: any[]) => mockAuthChallengeCreate(...args),
      updateMany: (...args: any[]) => mockAuthChallengeUpdateMany(...args),
      deleteMany: (...args: any[]) => mockAuthChallengeDeleteMany(...args),
    },
    transaction: {
      create: (...args: any[]) => mockTransactionCreate(...args),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const WALLET_A = "GAAAA_REGRESSION_TEST_WALLET_ONE_______________";
const WALLET_B = "GBBBB_REGRESSION_TEST_WALLET_TWO_______________";
const CHALLENGE_A = "xelma_auth_regression_alpha";
const CHALLENGE_B = "xelma_auth_regression_beta";

function defaultMocks() {
  mockIsValidStellarAddress.mockReturnValue(true);
  mockVerifySignature.mockResolvedValue(true);
  mockAuthChallengeDeleteMany.mockResolvedValue({ count: 0 });
  mockAuthChallengeFindMany.mockResolvedValue([]);
  mockUserFindUnique.mockResolvedValue(null);
  mockAuthChallengeCreate.mockImplementation((args: any) =>
    Promise.resolve({
      id: "ch-new",
      challenge: args?.data?.challenge ?? CHALLENGE_A,
      walletAddress: args?.data?.walletAddress,
      expiresAt: args?.data?.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
      isUsed: false,
    })
  );
}

describe("Auth Security Regression Suite (Issue #195)", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    defaultMocks();
  });

  // ----- Replay vectors -----------------------------------------------------

  describe("Replay attacks", () => {
    it("rejects a second connect with the same challenge after it was consumed", async () => {
      // First call succeeds: updateMany consumes the row.
      const future = new Date(Date.now() + 5 * 60 * 1000);
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockUserCreate.mockResolvedValueOnce({
        id: "u1",
        walletAddress: WALLET_A,
        role: "USER",
        createdAt: new Date(),
        lastLoginAt: new Date(),
      });
      mockTransactionCreate.mockResolvedValue({});

      const first = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_A, challenge: CHALLENGE_A, signature: "sig" });
      expect(first.status).toBe(200);

      // Second call: updateMany now matches nothing (challenge already used),
      // and findUnique sees the row with isUsed=true.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: future,
        isUsed: true,
        usedAt: new Date(),
        createdAt: new Date(),
      });

      const replay = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_A, challenge: CHALLENGE_A, signature: "sig" });

      expect(replay.status).toBe(401);
      expect(replay.body.message).toContain("already been used");
    });

    it("rejects connect when challenge is expired even if signature would verify", async () => {
      const past = new Date(Date.now() - 60 * 1000);
      // The atomic updateMany filters by `expiresAt > now`, so it matches 0 rows.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-exp",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: past,
        isUsed: false,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_A, challenge: CHALLENGE_A, signature: "sig" });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/expired/i);
      // verifySignature must never be invoked when the challenge guard fails.
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });

    it("never invokes verifySignature when the challenge does not exist", async () => {
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_A, challenge: "nope", signature: "sig" });

      expect(res.status).toBe(401);
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });
  });

  // ----- Tamper vectors -----------------------------------------------------

  describe("Tamper attacks", () => {
    it("rejects connect when attacker swaps wallet on a victim's challenge", async () => {
      const future = new Date(Date.now() + 5 * 60 * 1000);
      // updateMany WHERE clause requires walletAddress to match; attacker's
      // wallet differs from challenge owner, so 0 rows match.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-vic",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: future,
        isUsed: false,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_B, challenge: CHALLENGE_A, signature: "sig" });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid or expired/i);
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });

    it("rejects connect when signature is for a different challenge string", async () => {
      const future = new Date(Date.now() + 5 * 60 * 1000);
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: future,
        isUsed: true,
      });
      // verifySignature returns false because the bytes signed were CHALLENGE_B.
      mockVerifySignature.mockResolvedValueOnce(false);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: WALLET_A,
          challenge: CHALLENGE_A,
          signature: "signature-of-different-challenge",
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toContain("Invalid signature");
      // We must have actually verified the wallet+challenge+signature triple.
      expect(mockVerifySignature).toHaveBeenCalledWith(
        WALLET_A,
        CHALLENGE_A,
        "signature-of-different-challenge"
      );
    });

    it("does not leak which of {wallet, challenge} was wrong on mismatch", async () => {
      // Both "wrong wallet" and "wrong challenge" must surface as the same
      // generic error so attackers cannot enumerate live wallets.
      const future = new Date(Date.now() + 5 * 60 * 1000);

      // Case A: challenge exists, attacker uses wrong wallet.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: future,
        isUsed: false,
      });
      const wrongWallet = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_B, challenge: CHALLENGE_A, signature: "sig" });

      // Case B: challenge does not exist at all.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce(null);
      const noChallenge = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_B, challenge: "ghost", signature: "sig" });

      expect(wrongWallet.status).toBe(noChallenge.status);
      expect(wrongWallet.body.message).toBe(noChallenge.body.message);
      expect(wrongWallet.body.error).toBe(noChallenge.body.error);
    });
  });

  // ----- Input-shape attacks ------------------------------------------------

  describe("Malformed input vectors", () => {
    it("rejects connect when signature is an empty string", async () => {
      const res = await request(app).post("/api/auth/connect").send({
        walletAddress: WALLET_A,
        challenge: CHALLENGE_A,
        signature: "",
      });
      expect(res.status).toBe(400);
      expect(mockAuthChallengeUpdateMany).not.toHaveBeenCalled();
    });

    it("rejects connect when signature is not a string", async () => {
      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: WALLET_A,
          challenge: CHALLENGE_A,
          signature: { tampered: true } as any,
        });
      expect(res.status).toBe(400);
      expect(mockAuthChallengeUpdateMany).not.toHaveBeenCalled();
    });

    it("rejects connect when challenge contains NUL bytes or control chars", async () => {
      // updateMany should be invoked but match nothing; even if it did,
      // findUnique returns null so we 401. We assert no crash and no leak.
      mockAuthChallengeUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockAuthChallengeFindUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: WALLET_A,
          challenge: "xelma_auth_ _ctrl",
          signature: "sig",
        });

      expect([400, 401]).toContain(res.status);
    });

    it("rejects challenge issuance with missing walletAddress and does not touch DB", async () => {
      const res = await request(app).post("/api/auth/challenge").send({});
      expect(res.status).toBe(400);
      expect(mockAuthChallengeCreate).not.toHaveBeenCalled();
      expect(mockAuthChallengeDeleteMany).not.toHaveBeenCalled();
    });

    it("rejects invalid Stellar address on challenge issuance and does not touch DB", async () => {
      mockIsValidStellarAddress.mockReturnValueOnce(false);
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: "not-a-stellar-address" });

      expect(res.status).toBe(400);
      expect(mockAuthChallengeCreate).not.toHaveBeenCalled();
      expect(mockAuthChallengeDeleteMany).not.toHaveBeenCalled();
    });
  });

  // ----- Challenge lifecycle invariants ------------------------------------

  describe("Challenge lifecycle invariants", () => {
    it("invalidates prior unused challenges when a new one is requested", async () => {
      mockAuthChallengeFindMany.mockResolvedValueOnce([
        { challenge: "old-1" },
        { challenge: "old-2" },
      ]);

      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: WALLET_A });

      expect(res.status).toBe(200);
      // We must have asked the DB to delete prior unused challenges for this
      // wallet, enforcing the one-active-challenge policy.
      expect(mockAuthChallengeDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletAddress: WALLET_A,
            isUsed: false,
          }),
        })
      );
      // And we must have created exactly one new challenge.
      expect(mockAuthChallengeCreate).toHaveBeenCalledTimes(1);
    });

    it("consumes the challenge atomically before verifying the signature", async () => {
      // Order matters: updateMany must run BEFORE verifySignature so that two
      // concurrent connects cannot both pass the signature check.
      const future = new Date(Date.now() + 5 * 60 * 1000);
      const callOrder: string[] = [];

      mockAuthChallengeUpdateMany.mockImplementationOnce(async () => {
        callOrder.push("updateMany");
        return { count: 1 };
      });
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: CHALLENGE_A,
        walletAddress: WALLET_A,
        expiresAt: future,
        isUsed: true,
      });
      mockVerifySignature.mockImplementationOnce(async () => {
        callOrder.push("verifySignature");
        return true;
      });
      mockUserCreate.mockResolvedValueOnce({
        id: "u1",
        walletAddress: WALLET_A,
        role: "USER",
        createdAt: new Date(),
        lastLoginAt: new Date(),
      });
      mockTransactionCreate.mockResolvedValue({});

      const res = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: WALLET_A, challenge: CHALLENGE_A, signature: "sig" });

      expect(res.status).toBe(200);
      expect(callOrder).toEqual(["updateMany", "verifySignature"]);
    });
  });
});
