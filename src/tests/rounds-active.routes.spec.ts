import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";

const mockGetActiveRoundsWithFallback = jest.fn();

jest.mock("../services/round.service", () => ({
  __esModule: true,
  default: {
    startRound: jest.fn(),
    getRound: jest.fn(),
    getActiveRoundsWithFallback: (...args: any[]) =>
      mockGetActiveRoundsWithFallback(...args),
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
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("Rounds Routes - active round sourcing", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("GET /api/rounds/active returns soroban-sourced round", async () => {
    mockGetActiveRoundsWithFallback.mockResolvedValueOnce({
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

    const res = await request(app).get("/api/rounds/active");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
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
  });

  it("GET /api/rounds/active is registered before /:id", async () => {
    mockGetActiveRoundsWithFallback.mockResolvedValueOnce({
      source: "none",
      rounds: [],
    });

    const res = await request(app).get("/api/rounds/active");

    expect(res.status).toBe(200);
    expect(mockGetActiveRoundsWithFallback).toHaveBeenCalled();
  });
});
