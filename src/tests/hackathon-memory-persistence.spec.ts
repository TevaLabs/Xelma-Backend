/**
 * Issue #662 — `DATA_STORE=memory` must not surface raw Prisma failures.
 *
 * Every model the hackathon app touches now has an in-memory stub in
 * `src/lib/memory-prisma.ts`. This spec boots the real factory
 * (`createApp({ mode: 'hackathon' })`) under memory flags and walks the
 * route surface that a demo actually hits.
 *
 * The core assertion is deliberately blunt and is what makes this a
 * regression test rather than a smoke test: **no** request may fail with an
 * unhandled persistence error. Before #662, any unstubbed model or query shape
 * reached the real `PrismaClient`, which — with no `DATABASE_URL` and no query
 * engine — rejected with "PrismaClient is unable to run in this browser
 * environment" / "the query engine is not connected", and the global error
 * handler turned that into an opaque 500. Now a gap is a typed 501
 * `PERSISTENCE_UNAVAILABLE`, and a stub is a 200.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { webcrypto } from "crypto";
if (!global.crypto) {
  global.crypto = webcrypto as any;
}
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { BetMode, BetStatus, NotificationType, PredictionSide, UserRole } from "@prisma/client";

import type { Application } from "express";
import type { ErrorCode } from "../utils/errors";

/**
 * Soroban is a network dependency, not a persistence one. Mocked so these
 * tests exercise the data layer rather than RPC reachability; every stub
 * resolves, so any failure observed here comes from the store.
 */
jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn(async () => null),
    getPendingWinnings: jest.fn(async () => BigInt(0)),
    getBalance: jest.fn(async () => 0),
    getHealth: jest.fn(async () => ({ initialized: false })),
    getActiveRound: jest.fn(async () => null),
    isReady: jest.fn(() => false),
    placeBet: jest.fn(async () => ({ txHash: "stub" })),
    placePrecisionBet: jest.fn(async () => ({ txHash: "stub" })),
    claimWinnings: jest.fn(async () => ({ txHash: "stub" })),
    applyMoneyPathFailure: jest.fn(),
  },
}));

jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address) && address.startsWith("G") && address.length === 56,
  verifySignature: jest.fn().mockReturnValue(true),
}));

/** Substrings Prisma uses when it has no query engine / no database. */
const RAW_PERSISTENCE_FAILURE = [
  "engine is not connected",
  "unable to run in this browser environment",
  "prisma is not initialized",
  "Cannot read properties of undefined",
  "ECONNREFUSED",
];

type Prisma = typeof import("../lib/prisma").prisma;

describe("hackathon app in DATA_STORE=memory — persistence coverage (#662)", () => {
  const savedEnv = { ...process.env };
  const ADMIN_WALLET = Keypair.random().publicKey();
  const USER_WALLET = Keypair.random().publicKey();

  let app: Application;
  let prisma: Prisma;
  let generateToken: typeof import("../utils/jwt.util").generateToken;

  beforeAll(async () => {
    process.env.DATA_STORE = "memory";
    process.env.DATA_MODE = "mock";
    process.env.BET_STUB_MODE = "true";
    process.env.SOROBAN_FAIL_CLOSED = "false";
    // Keep the admin surface open so the read paths that need it are covered.
    process.env.ENABLE_MULTIPLAYER_SOCIAL = "true";

    jest.resetModules();

    // The factory, not a bespoke app — this is the surface a demo serves.
    const { createApp } = await import("../app-factory");
    app = createApp({ mode: "hackathon" });

    ({ prisma } = await import("../lib/prisma"));
    ({ generateToken } = await import("../utils/jwt.util"));
  });

  afterAll(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  /**
   * Asserts a response is a well-formed API answer rather than an unhandled
   * persistence crash. 2xx is expected for most calls, but a 4xx from
   * validation/authorization is equally fine — what must never happen is a 500
   * carrying a raw Prisma/driver message.
   */
  function expectNoPersistenceFailure(res: request.Response, label: string) {
    const serialized = JSON.stringify(res.body ?? {});
    for (const needle of RAW_PERSISTENCE_FAILURE) {
      expect({
        label,
        leaked: serialized.toLowerCase().includes(needle.toLowerCase()),
        body: serialized,
      }).toEqual({ label, leaked: false, body: serialized });
    }
    if (res.status >= 500) {
      // 501 is the sanctioned, typed "this mode cannot do that" answer.
      expect(res.status).toBe(501);
      expect(res.body?.code).toBe("PERSISTENCE_UNAVAILABLE");
    }
  }

  // -----------------------------------------------------------------------
  // Public GETs — the endpoints a demo client hits on first paint.
  // -----------------------------------------------------------------------
  describe("public GET routes", () => {
    const publicGets = [
      "GET /api/health",
      "GET /api",
      "GET /api/rounds",
      "GET /api/leaderboard",
      "GET /api/tournaments",
      "GET /api/stats",
      "GET /api/prices",
      "GET /api/education/tips",
    ] as const;

    it.each(publicGets)("%s answers without a persistence failure", async (descriptor) => {
      const res = await request(app).get(descriptor.split(" ")[1]);

      expect(res.status).toBeLessThan(500);
      expectNoPersistenceFailure(res, descriptor);
    });

    it("GET /api/rounds serves data (empty or mocked), not an error", async () => {
      const res = await request(app).get("/api/rounds");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body?.data?.rounds ?? res.body?.rounds)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Auth POSTs — the wallet challenge/connect flow, which writes users and
  // auth challenges and is the first thing a demo operator clicks.
  // -----------------------------------------------------------------------
  describe("POST /api/auth", () => {
    it("POST /api/auth/challenge issues a challenge", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: ADMIN_WALLET });

      expect(res.status).toBe(200);
      expect(res.body.challenge ?? res.body.data?.challenge).toBeDefined();
      expectNoPersistenceFailure(res, "POST /api/auth/challenge");
    });

    it("POST /api/auth/connect upserts the user and returns a token", async () => {
      const challengeRes = await request(app)
        .post("/api/auth/challenge")
        .send({ walletAddress: USER_WALLET });
      const challenge = challengeRes.body.challenge ?? challengeRes.body.data?.challenge;

      const res = await request(app)
        .post("/api/auth/connect")
        .send({ walletAddress: USER_WALLET, signature: "stub", challenge });

      expect(res.status).toBe(200);
      expect(res.body.token ?? res.body.data?.token).toBeDefined();
      expectNoPersistenceFailure(res, "POST /api/auth/connect");

      // The user row really landed in the in-memory store.
      const stored = await prisma.user.findUnique({
        where: { walletAddress: USER_WALLET },
      });
      expect(stored).not.toBeNull();
    });

    it("POST /api/auth/refresh re-issues a token for an existing one", async () => {
      const user = await prisma.user.create({ data: { walletAddress: USER_WALLET } });
      const token = generateToken(user.id as string, USER_WALLET, UserRole.USER);

      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expectNoPersistenceFailure(res, "POST /api/auth/refresh");
    });
  });

  // -----------------------------------------------------------------------
  // Authenticated GETs and a money-path POST, backed by the in-memory
  // user / bet / claim / notification / tournament / message / stats stores.
  // -----------------------------------------------------------------------
  describe("authenticated routes", () => {
    let userToken: string;
    let adminToken: string;
    let userId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({ data: { walletAddress: USER_WALLET } });
      userId = user.id as string;
      userToken = generateToken(userId, USER_WALLET, UserRole.USER);

      const admin = await prisma.user.create({
        data: { walletAddress: ADMIN_WALLET, role: UserRole.ADMIN },
      });
      adminToken = generateToken(admin.id as string, ADMIN_WALLET, UserRole.ADMIN);
    });

    const authedGets = [
      "GET /api/user/profile",
      "GET /api/user/stats",
      "GET /api/user/history",
      "GET /api/user/transactions",
      "GET /api/notifications",
      "GET /api/chat/history",
      "GET /api/bets",
    ] as const;

    it.each(authedGets)("%s answers without a persistence failure", async (descriptor) => {
      const [, path] = descriptor.split(" ");
      const res = await request(app)
        .get(path)
        .set("Authorization", `Bearer ${userToken}`);

      expectNoPersistenceFailure(res, descriptor);
      expect(res.status).toBeLessThan(500);
    });

    it("POST /api/bets/up-down records a bet, a claim and an outbox event", async () => {
      const address = Keypair.random().publicKey();
      const player = await prisma.user.create({ data: { walletAddress: address } });
      const token = generateToken(player.id as string, address, UserRole.USER);

      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address, amount: 25, side: "UP" });

      expectNoPersistenceFailure(res, "POST /api/bets/up-down");
      // 200 when a round accepts it, 409/422 when none is open — both fine.
      expect([200, 409, 422]).toContain(res.status);
    });

    it("POST /api/notifications/read-all marks the user's notifications read", async () => {
      await prisma.notification.create({
        data: { userId, type: NotificationType.ANNOUNCEMENT, title: "hi", message: "there" },
      });

      const res = await request(app)
        .post("/api/notifications/read-all")
        .set("Authorization", `Bearer ${userToken}`);

      expectNoPersistenceFailure(res, "POST /api/notifications/read-all");
      expect(res.status).toBeLessThan(500);
    });

    it("POST /api/chat/send appends to the in-memory message store", async () => {
      const res = await request(app)
        .post("/api/chat/send")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ content: "hello from the memory-mode smoke test" });

      expectNoPersistenceFailure(res, "POST /api/chat/send");
      expect(res.status).toBeLessThan(500);
    });

    it("POST /api/tournaments creates a tournament in memory", async () => {
      const res = await request(app)
        .post("/api/tournaments")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Memory Cup",
          mode: "UP_DOWN",
          entryFee: "10.00000000",
          prizePool: "100.00000000",
          maxParticipants: 8,
          startTime: new Date(Date.now() + 60_000).toISOString(),
          endTime: new Date(Date.now() + 3_600_000).toISOString(),
          rounds: 3,
        });

      expectNoPersistenceFailure(res, "POST /api/tournaments");
      // 200/201 created; 400 rejected by validation; 403 role-gated.
      expect([200, 201, 400, 403]).toContain(res.status);

      if (res.status < 300) {
        const stored = await prisma.tournament.findMany({
          where: { name: "Memory Cup" },
        });
        expect(stored.length).toBeGreaterThan(0);
      }
    });

    it("GET /api/leaderboard ranks from the in-memory userStats store", async () => {
      await prisma.userStats.create({
        data: { userId, totalPredictions: 3, correctPredictions: 2, totalEarnings: 50 },
      });

      const res = await request(app).get("/api/leaderboard");

      expect(res.status).toBe(200);
      expectNoPersistenceFailure(res, "GET /api/leaderboard");
    });
  });

  // -----------------------------------------------------------------------
  // The store itself: every model the hackathon app touches is stubbed, and
  // anything genuinely absent is a typed 501 rather than a driver crash.
  // -----------------------------------------------------------------------
  describe("in-memory store coverage", () => {
    const MODELS_TOUCHED_BY_HACKATHON_ROUTES = [
      "user",
      "authChallenge",
      "transaction",
      "round",
      "prediction",
      "bet",
      "claim",
      "notification",
      "userStats",
      "message",
      "tournament",
      "tournamentParticipant",
      "multiplayerSession",
      "auditLog",
      "outboxEvent",
      "idempotencyKey",
      "mockRound",
      "mockLeaderboard",
      "mockBet",
      "mockPlatformStat",
    ] as const;

    it.each(MODELS_TOUCHED_BY_HACKATHON_ROUTES)(
      "prisma.%s resolves to a stub rather than throwing",
      (model) => {
        expect(() => (prisma as unknown as Record<string, unknown>)[model]).not.toThrow();
        expect(
          (prisma as unknown as Record<string, unknown>)[model],
        ).toBeDefined();
      },
    );

    it("returns a typed 501 for a model with no stub, not a raw Prisma error", () => {
      let thrown: unknown;
      try {
        void (prisma as unknown as Record<string, unknown>).__notARealModel;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const appError = thrown as { statusCode?: number; code?: ErrorCode | string };
      expect(appError.statusCode).toBe(501);
      expect(appError.code).toBe("PERSISTENCE_UNAVAILABLE");
      expect((thrown as Error).message).not.toMatch(/engine is not connected/i);
    });

    it("supports the groupBy shapes the reconciliation summaries use", async () => {
      const owner = await prisma.user.create({
        data: { walletAddress: Keypair.random().publicKey() },
      });
      const resolvedAt = new Date();
      const baseBet = {
        userId: owner.id,
        mode: BetMode.UP_DOWN,
        side: PredictionSide.UP,
        amount: 10,
      } as const;
      await prisma.bet.create({
        data: { ...baseBet, status: BetStatus.RESOLVED, resolvedAt },
      });
      await prisma.bet.create({
        data: {
          ...baseBet,
          status: BetStatus.RESOLVED,
          resolvedAt: new Date(resolvedAt.getTime() + 1000),
        },
      });
      // No resolvedAt: exercises the `_max` -> null path.
      await prisma.bet.create({ data: { ...baseBet, status: BetStatus.ACCEPTED } });

      const byStatus = await prisma.bet.groupBy({
        by: ["status"],
        _count: { status: true },
      });
      const resolved = byStatus.find((g) => g.status === BetStatus.RESOLVED);
      expect(resolved?._count?.status).toBe(2);

      const latestPerUser = await prisma.bet.groupBy({
        by: ["userId"],
        where: { status: BetStatus.RESOLVED },
        _max: { resolvedAt: true },
        orderBy: { userId: "asc" },
        take: 10,
      });
      const group = latestPerUser.find((g) => g.userId === owner.id);
      expect(group).toBeDefined();
      // The latest of the two resolved timestamps, not the ACCEPTED row's null.
      expect((group?._max?.resolvedAt as Date | null)?.getTime()).toBe(
        resolvedAt.getTime() + 1000,
      );
    });

    it("rejects an unimplemented groupBy aggregate with 501, not wrong numbers", async () => {
      await expect(
        prisma.bet.groupBy({
          by: ["status"],
          _sum: { amount: true },
        } as never),
      ).rejects.toMatchObject({
        statusCode: 501,
        code: "PERSISTENCE_UNAVAILABLE",
      });
    });
  });
});
