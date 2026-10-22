import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import { assertNoNumericMoney } from "../serializers/monetary.serializer";

const mockGetRoundsForApi = jest.fn();

jest.mock("../services/round.service", () => ({
  __esModule: true,
  default: {
    startRound: jest.fn(),
    getRound: jest.fn(),
    getRoundsForApi: (...args: any[]) => mockGetRoundsForApi(...args),
  },
}));

jest.mock("../services/resolution.service", () => ({
  __esModule: true,
  default: {
    resolveRound: jest.fn(),
  },
}));

jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("Rounds Routes - active round sourcing", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("GET /api/rounds returns soroban-sourced round via sendSuccess", async () => {
    mockGetRoundsForApi.mockResolvedValueOnce({
      source: "soroban",
      rounds: [
        {
          id: "soroban-1",
          sorobanRoundId: "1",
          mode: "UP_DOWN",
          status: "ACTIVE",
          startPrice: 0.12,
          poolUp: 1,
          poolDown: 2,
          isSoroban: true,
          source: "soroban",
        },
      ],
    });

    const res = await request(app).get("/api/rounds");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe("soroban");
    expect(res.body.data.rounds).toHaveLength(1);
    expect(res.body.data.rounds[0].id).toBe("soroban-1");
    expect(res.body.data.rounds[0].poolUp).toBe("1.00000000");
    expect(res.body.data.rounds[0].poolDown).toBe("2.00000000");
    assertNoNumericMoney(res.body);
  });

  it("GET /api/rounds returns empty list when no active rounds", async () => {
    mockGetRoundsForApi.mockResolvedValueOnce({
      source: "none",
      rounds: [],
    });

    const res = await request(app).get("/api/rounds");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe("none");
    expect(res.body.data.rounds).toEqual([]);
  });

  it("GET /api/rounds/active returns active rounds with decimal-serialized pool totals (Issue #820)", async () => {
    mockGetRoundsForApi.mockResolvedValueOnce({
      source: "soroban",
      rounds: [
        {
          id: "soroban-1",
          sorobanRoundId: "1",
          mode: "UP_DOWN",
          status: "ACTIVE",
          startPrice: 0.12,
          poolUp: 125.5,
          poolDown: 75.25,
          isSoroban: true,
          source: "soroban",
        },
      ],
    });

    const res = await request(app).get("/api/rounds/active");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe("soroban");
    expect(res.body.data.rounds).toHaveLength(1);

    const round = res.body.data.rounds[0];
    expect(round.id).toBe("soroban-1");
    expect(typeof round.poolUp).toBe("string");
    expect(round.poolUp).toBe("125.50000000");
    expect(typeof round.poolDown).toBe("string");
    expect(round.poolDown).toBe("75.25000000");

    // Also assert top-level backward compatibility alias
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0].poolUp).toBe("125.50000000");
    expect(res.body.rounds[0].poolDown).toBe("75.25000000");

    assertNoNumericMoney(res.body);
  });

  it("GET /api/rounds/active is registered before /:id and handles rounds with default zero pools", async () => {
    mockGetRoundsForApi.mockResolvedValueOnce({
      source: "database",
      rounds: [
        {
          id: "round-without-pools",
          mode: "UP_DOWN",
          status: "ACTIVE",
          startPrice: 0.5,
        },
      ],
    });

    const res = await request(app).get("/api/rounds/active");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rounds[0].poolUp).toBe("0.00000000");
    expect(res.body.data.rounds[0].poolDown).toBe("0.00000000");
    assertNoNumericMoney(res.body);
  });
});
