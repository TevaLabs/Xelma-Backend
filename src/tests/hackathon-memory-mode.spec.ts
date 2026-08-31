import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Boots the hackathon app with DATA_STORE=memory (the DB-less demo mode) and
 * exercises the routes that previously called `prisma.*` directly with no
 * in-memory equivalent — see src/lib/memory-prisma.ts. Before that fix these
 * calls fell through to a real (unreachable) PrismaClient and crashed with
 * opaque connection errors instead of serving the demo.
 */

jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address) && address.startsWith("G") && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn().mockResolvedValue(null),
    getPendingWinnings: jest.fn().mockResolvedValue(BigInt(0)),
    getBalance: jest.fn().mockResolvedValue(0),
    getHealth: jest.fn().mockResolvedValue({ initialized: false }),
    getActiveRound: jest.fn().mockResolvedValue(null),
    isReady: jest.fn().mockReturnValue(false),
  },
}));

describe("hackathon app in DATA_STORE=memory mode", () => {
  const savedEnv = { ...process.env };
  const WALLET_A = Keypair.random().publicKey();
  const WALLET_B = Keypair.random().publicKey();

  let app: import("express").Application;
  let prisma: typeof import("../lib/prisma").prisma;
  let generateToken: typeof import("../utils/jwt.util").generateToken;

  beforeAll(async () => {
    process.env.DATA_STORE = "memory";
    process.env.DATA_MODE = "mock";

    jest.resetModules();

    const appModule = await import("../app");
    app = appModule.createApp();

    ({ prisma } = await import("../lib/prisma"));
    ({ generateToken } = await import("../utils/jwt.util"));
  });

  afterAll(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  it("boots without needing a real database connection", () => {
    expect(app).toBeDefined();
  });

  describe("POST /api/auth/challenge", () => {
    it("issues a challenge without hitting a real Prisma connection", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: WALLET_A });

      expect(res.status).toBe(200);
      expect(res.body.challenge ?? res.body.data?.challenge).toBeDefined();
    });

    it("invalidates a prior unused challenge for the same wallet on a second request", async () => {
      const first = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: WALLET_B });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: WALLET_B });
      expect(second.status).toBe(200);

      const remaining = await prisma.authChallenge.findMany({
        where: { walletAddress: WALLET_B, isUsed: false },
      });
      expect(remaining).toHaveLength(1);
    });
  });

  describe("critical GET routes", () => {
    it("GET /api/rounds succeeds", async () => {
      const res = await request(app).get("/api/rounds");
      expect(res.status).toBe(200);
    });

    it("GET /api/tournaments succeeds", async () => {
      const res = await request(app).get("/api/tournaments");
      expect(res.status).toBe(200);
    });

    it("GET /api/stats succeeds", async () => {
      const res = await request(app).get("/api/stats");
      expect(res.status).toBe(200);
    });
  });

  describe("authenticated routes backed by the in-memory user store", () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { walletAddress: Keypair.random().publicKey() },
      });
      userId = user.id as string;
      token = generateToken(userId, user.walletAddress as string, "USER" as any);
    });

    it("GET /api/user/profile returns the in-memory user", async () => {
      const res = await request(app)
        .get("/api/user/profile")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it("GET /api/notifications returns an empty list instead of crashing", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([]);
    });
  });

  describe("bet placement (prisma.$transaction callback path)", () => {
    let betService: typeof import("../services/bet.service").default;

    beforeAll(async () => {
      process.env.BET_STUB_MODE = "true";
      ({ default: betService } = await import("../services/bet.service"));
    });

    afterAll(() => {
      delete process.env.BET_STUB_MODE;
    });

    it("creates a user, a bet, and an outbox event inside one in-memory transaction", async () => {
      const address = Keypair.random().publicKey();

      const result = await betService.recordUpDownBet({
        address,
        amount: 10,
        side: "UP",
      });

      expect(result.betId).toBeDefined();

      const user = await prisma.user.findUnique({ where: { walletAddress: address } });
      expect(user).not.toBeNull();

      const bet = await prisma.bet.findUnique({ where: { id: result.betId } });
      expect(bet?.userId).toBe(user!.id);

      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: result.betId },
      });
      expect(events.length).toBeGreaterThan(0);
    });
  });
});
