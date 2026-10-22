import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import statsRouter from '../routes/stats';
import { setRepositoriesForTests } from '../repositories';
import { STATS_CACHE_TTL_ENV } from '../utils/http-cache';

const mockGetPlatformStats = jest.fn();

function buildApp() {
  const app = express();
  app.use('/api/stats', statsRouter);
  return app;
}

const publicHeader = (ttl: number) =>
  `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl}`;

describe('GET /api/stats cache headers (Issue #876)', () => {
  beforeEach(() => {
    delete process.env[STATS_CACHE_TTL_ENV];
    mockGetPlatformStats.mockResolvedValue({
      totalRounds: 142,
      totalUsers: 89,
      totalBets: 530,
      isFallback: false,
      cachedAt: new Date().toISOString(),
    });
    setRepositoriesForTests({
      rounds: { placeBet: jest.fn() },
      leaderboard: { listLeaderboard: jest.fn() },
      stats: {
        getPlatformStats: mockGetPlatformStats,
        invalidateStatsCache: jest.fn(),
      },
    } as any);
  });

  afterEach(() => {
    setRepositoriesForTests(null);
    delete process.env[STATS_CACHE_TTL_ENV];
    jest.clearAllMocks();
  });

  it('serves a short public Cache-Control by default', async () => {
    const res = await request(buildApp()).get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(publicHeader(5));
  });

  it('is CDN friendly: the default window is shorter than the price feed', async () => {
    const res = await request(buildApp()).get('/api/stats');

    const maxAge = Number(/max-age=(\d+)/.exec(res.headers['cache-control'])?.[1]);
    expect(maxAge).toBeLessThan(30);
  });

  it('honours STATS_CACHE_TTL_SECONDS when it is set', async () => {
    process.env[STATS_CACHE_TTL_ENV] = '1';

    const res = await request(buildApp()).get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(publicHeader(1));
  });

  it('falls back to the default when STATS_CACHE_TTL_SECONDS is invalid', async () => {
    process.env[STATS_CACHE_TTL_ENV] = 'not-a-number';

    const res = await request(buildApp()).get('/api/stats');

    expect(res.headers['cache-control']).toBe(publicHeader(5));
  });

  it('never lets a CDN cache a failed stats response', async () => {
    mockGetPlatformStats.mockRejectedValueOnce(new Error('db exploded'));

    const res = await request(buildApp()).get('/api/stats');

    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
  });
});
