import { describe, it, expect, afterEach } from '@jest/globals';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../app';
import { setRepositoriesForTests } from '../repositories';

jest.mock('../middleware/rateLimiter.middleware', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    apiRateLimiter: pass,
    writeRateLimiter: pass,
    betRateLimiter: pass,
    challengeRateLimiter: pass,
    connectRateLimiter: pass,
    authRateLimiter: pass,
    chatMessageRateLimiter: pass,
    predictionRateLimiter: pass,
    batchPredictionRateLimiter: pass,
    batchLeaderboardRateLimiter: pass,
    adminRoundRateLimiter: pass,
    oracleResolveRateLimiter: pass,
  };
});

jest.mock('../services/priceService', () => ({
  __esModule: true,
  getPrices: jest.fn(),
}));

import { getPrices } from '../services/priceService';

const app = createApp();

afterEach(() => {
  setRepositoriesForTests(null);
  jest.clearAllMocks();
});

const emptyRepos = () => ({
  rounds: { listActiveRounds: jest.fn(), placeBet: jest.fn() },
  leaderboard: { listLeaderboard: jest.fn() },
  stats: { getPlatformStats: jest.fn(), invalidateStatsCache: jest.fn() },
});

describe('API Contract Tests - frontend-critical endpoints (Issue #333)', () => {
  describe('GET /api/rounds', () => {
    const roundsContract = z.object({
      success: z.literal(true),
      data: z.array(
        z.object({
          id: z.string(),
          mode: z.string(),
          status: z.string(),
          startPrice: z.union([z.string(), z.number()]),
        }),
      ),
    });

    it('matches the documented response contract', async () => {
      const repos = emptyRepos();
      (repos.rounds.listActiveRounds as jest.Mock).mockResolvedValue([
        { id: 'r-1', mode: 'UP_DOWN', status: 'ACTIVE', startPrice: 0.1234 },
      ]);
      setRepositoriesForTests(repos as any);

      const res = await request(app).get('/api/rounds');

      expect(res.status).toBe(200);
      expect(() => roundsContract.parse(res.body)).not.toThrow();
    });
  });

  describe('GET /api/leaderboard', () => {
    const leaderboardContract = z.object({
      success: z.literal(true),
      data: z.object({
        entries: z.array(
          z.object({
            userId: z.string(),
            rank: z.number(),
            score: z.union([z.string(), z.number()]),
          }),
        ),
      }),
      meta: z.object({
        pagination: z.object({
          limit: z.number(),
          offset: z.number(),
          total: z.number(),
        }),
      }),
    });

    it('matches the documented response contract', async () => {
      const repos = emptyRepos();
      (repos.leaderboard.listLeaderboard as jest.Mock).mockResolvedValue({
        entries: [{ userId: 'u-1', rank: 1, score: 100 }],
        pagination: { limit: 100, offset: 0, total: 1 },
      });
      setRepositoriesForTests(repos as any);

      const res = await request(app).get('/api/leaderboard');

      expect(res.status).toBe(200);
      expect(() => leaderboardContract.parse(res.body)).not.toThrow();
    });
  });

  describe('GET /api/stats', () => {
    const statsContract = z.object({
      success: z.literal(true),
      data: z.object({
        totalRounds: z.number(),
        totalUsers: z.number(),
        totalBets: z.number(),
        isFallback: z.boolean(),
        cachedAt: z.string(),
      }),
    });

    it('matches the documented response contract', async () => {
      const repos = emptyRepos();
      (repos.stats.getPlatformStats as jest.Mock).mockResolvedValue({
        totalRounds: 142,
        totalUsers: 89,
        totalBets: 530,
        isFallback: false,
        cachedAt: new Date().toISOString(),
      });
      setRepositoriesForTests(repos as any);

      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(200);
      expect(() => statsContract.parse(res.body)).not.toThrow();
    });
  });

  describe('GET /api/prices', () => {
    const pricesContract = z.object({
      success: z.literal(true),
      data: z.object({
        BTC: z.number(),
        ETH: z.number(),
        XLM: z.number(),
        stale: z.boolean(),
        lastUpdatedAt: z.string().nullable(),
      }),
    });

    it('matches the documented response contract', async () => {
      (getPrices as jest.Mock).mockResolvedValue({
        BTC: 60000,
        ETH: 3000,
        XLM: 0.2891,
        stale: false,
        lastUpdatedAt: new Date().toISOString(),
      });

      const res = await request(app).get('/api/prices');

      expect(res.status).toBe(200);
      expect(() => pricesContract.parse(res.body)).not.toThrow();
    });
  });
});