/**

 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";
import * as stellarService from "../services/stellar.service";

jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn(),
  isValidStellarAddress: jest.fn(),
}));

// Bypass rate limiters in tests so we don't get 429; include any used by other routes (e.g. rounds)
jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
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
const mockAuthChallengeCreate = jest.fn();
const mockAuthChallengeUpdate = jest.fn();
const mockAuthChallengeDelete = jest.fn();
const mockAuthChallengeDeleteMany = jest.fn();
const mockTransactionCreate = jest.fn();
const mockTransactionDeleteMany = jest.fn();
const mockNotificationFindMany = jest.fn();
const mockNotificationCount = jest.fn();

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
      create: (...args: any[]) => mockAuthChallengeCreate(...args),
      update: (...args: any[]) => mockAuthChallengeUpdate(...args),
      delete: (...args: any[]) => mockAuthChallengeDelete(...args),
      deleteMany: (...args: any[]) => mockAuthChallengeDeleteMany(...args),
    },
    transaction: {
      create: (...args: any[]) => mockTransactionCreate(...args),
      deleteMany: (...args: any[]) => mockTransactionDeleteMany(...args),
    },
    notification: {
      findMany: (...args: any[]) => mockNotificationFindMany(...args),
      count: (...args: any[]) => mockNotificationCount(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const VALID_WALLET = "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";
const TEST_USER_ID = "auth-test-user-id";
const TEST_WALLET = "GAUTH_TEST_USER_WALLET_ADDRESS_____________";

describe("Auth Routes & JWT Guards (Issue #78)", () => {
  let app: Express;
  let testUser: { id: string; walletAddress: string };
  let validToken: string;

  beforeAll(async () => {
    app = createApp();
    mockIsValidStellarAddress.mockReturnValue(true);
    mockVerifySignature.mockResolvedValue(true);

    testUser = { id: TEST_USER_ID, walletAddress: TEST_WALLET };
    validToken = generateToken(testUser.id, testUser.walletAddress);

    mockUserFindUnique.mockImplementation((args: any) => {
      const id = args?.where?.id;
      if (id === testUser.id)
        return Promise.resolve({ id: testUser.id, walletAddress: testUser.walletAddress, role: "USER" });
      return Promise.resolve(null);
    });
    mockAuthChallengeDeleteMany.mockResolvedValue({ count: 0 });
    mockAuthChallengeCreate.mockImplementation((args: any) =>
      Promise.resolve({
        id: "ch-1",
        challenge: args?.data?.challenge ?? "xelma_auth_123",
        walletAddress: args?.data?.walletAddress,
        expiresAt: args?.data?.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
        isUsed: false,
      })
    );
  });

  beforeEach(() => {
    mockIsValidStellarAddress.mockReturnValue(true);
    mockVerifySignature.mockResolvedValue(true);
    mockUserFindUnique.mockImplementation((args: any) => {
      const id = args?.where?.id;
      if (id === testUser.id)
        return Promise.resolve({ id: testUser.id, walletAddress: testUser.walletAddress, role: "USER" });
      return Promise.resolve(null);
    });
  });

  afterAll(async () => {
    jest.clearAllMocks();
  });

  describe("POST /api/auth/challenge", () => {
    it("should return 400 when walletAddress is missing", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation Error");
      expect(res.body.message).toContain("walletAddress is required");
    });

    it("should return 400 for invalid Stellar wallet address format", async () => {
      mockIsValidStellarAddress.mockReturnValueOnce(false);

      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: "not-a-valid-address" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation Error");
      expect(res.body.message).toContain("Invalid Stellar wallet address format");
    });

    it("should return 200 with challenge and expiresAt for valid wallet", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: VALID_WALLET });

      expect(res.status).toBe(200);
      expect(res.body.challenge).toBeDefined();
      expect(res.body.challenge).toMatch(/^xelma_auth_/);
      expect(res.body.expiresAt).toBeDefined();
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("POST /api/auth/connect", () => {
    it("should return 400 when walletAddress, challenge, or signature is missing", async () => {
      const res = await request(app).post("/api/auth/connect").send({
        walletAddress: VALID_WALLET,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation Error");
      expect(res.body.message).toContain("walletAddress, challenge, and signature are required");
    });

    it("should return 400 for invalid Stellar address on connect", async () => {
      mockIsValidStellarAddress.mockReturnValueOnce(false);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: "invalid",
          challenge: "xelma_auth_123_abc",
          signature: "base64sig",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Invalid Stellar wallet address format");
    });

    it("should return 401 for invalid or expired challenge", async () => {
      mockAuthChallengeFindUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: VALID_WALLET,
          challenge: "nonexistent-challenge-12345",
          signature: "somesignature",
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Authentication Error");
      expect(res.body.message).toContain("Invalid or expired challenge");
    });

    it("should return 401 when challenge belongs to different wallet", async () => {
      const future = new Date(Date.now() + 5 * 60 * 1000);
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: "xelma_auth_wrong_wallet_challenge",
        walletAddress: "GDIFFERENT_WALLET_____________________________",
        expiresAt: future,
        isUsed: false,
      });

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: VALID_WALLET,
          challenge: "xelma_auth_wrong_wallet_challenge",
          signature: "somesignature",
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toContain("Challenge does not match wallet address");
    });

    it("should return 401 when signature is invalid", async () => {
      const future = new Date(Date.now() + 5 * 60 * 1000);
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: "xelma_auth_invalid_sig_test",
        walletAddress: VALID_WALLET,
        expiresAt: future,
        isUsed: false,
      });
      mockVerifySignature.mockResolvedValueOnce(false);

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: VALID_WALLET,
          challenge: "xelma_auth_invalid_sig_test",
          signature: "badsignature",
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toContain("Invalid signature");
    });

    it("should return 200 with token and user on valid connect (new user)", async () => {
      const newWallet = "GNEW_USER_AUTH_CONNECT_TEST___________________";
      mockIsValidStellarAddress.mockImplementation((addr: string) =>
        addr === newWallet || addr === VALID_WALLET
      );

      const future = new Date(Date.now() + 5 * 60 * 1000);
      mockAuthChallengeFindUnique.mockResolvedValueOnce({
        id: "ch-1",
        challenge: "xelma_auth_new_user_connect_test",
        walletAddress: newWallet,
        expiresAt: future,
        isUsed: false,
      });
      mockVerifySignature.mockResolvedValueOnce(true);
      mockUserFindUnique.mockResolvedValueOnce(null);
      const newUser = {
        id: "new-user-id",
        walletAddress: newWallet,
        createdAt: new Date(),
        lastLoginAt: new Date(),
      };
      mockUserCreate.mockResolvedValueOnce(newUser);
      mockTransactionCreate.mockResolvedValueOnce({});
      mockAuthChallengeUpdate.mockResolvedValueOnce({});
      mockAuthChallengeDeleteMany.mockResolvedValueOnce({ count: 0 });

      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: newWallet,
          challenge: "xelma_auth_new_user_connect_test",
          signature: "validsignature",
        });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.walletAddress).toBe(newWallet);
      expect(res.body.user.id).toBeDefined();
    });
  });

  describe("JWT guards (protected routes)", () => {
    it("should return 401 when no token is provided", async () => {
      const res = await request(app).get("/api/notifications");

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it("should return 401 when token is invalid or expired", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", "Bearer invalid.token.here");

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it("should allow access with valid JWT", async () => {
      mockNotificationFindMany.mockResolvedValue([]);
      mockNotificationCount.mockResolvedValue(0);

      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notifications).toBeDefined();
    });

    it("should reject malformed Authorization header", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", "InvalidFormat token");

      expect(res.status).toBe(401);
    });
  });
});
