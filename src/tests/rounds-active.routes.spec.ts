import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";

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
});
