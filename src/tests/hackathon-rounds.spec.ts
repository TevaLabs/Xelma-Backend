import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../app';

const mockGetRoundsForApi = jest.fn();

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: {
    getRoundsForApi: (...args: any[]) => mockGetRoundsForApi(...args),
  },
}));

jest.mock('../services/hackathon.service', () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn().mockResolvedValue(undefined),
    getRounds: jest.fn().mockResolvedValue([]),
    getLeaderboard: jest.fn().mockResolvedValue([]),
    getUserStats: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../middleware/rateLimiter', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { apiRateLimiter: pass, writeRateLimiter: pass, betRateLimiter: pass };
});

const SOROBAN_ROUND_RESPONSE = {
  source: 'soroban',
  rounds: [
    {
      id: 'soroban-1',
      sorobanRoundId: '1',
      mode: 'UP_DOWN',
      status: 'ACTIVE',
      startPrice: 0.2891,
      poolUp: 2.8,
      poolDown: 1.4,
      startLedger: 100,
      betEndLedger: 200,
      endLedger: 300,
      isSoroban: true,
      source: 'soroban',
    },
  ],
};

const MOCK_ROUND_RESPONSE = {
  source: 'mock',
  rounds: [
    { id: 'btc-updown-live', asset: 'XLM', mode: 'updown', status: 'live', startPrice: 0.5, poolUp: 100, poolDown: 200, closesAt: new Date(Date.now() + 3600000).toISOString() },
  ],
};

describe('GET /api/rounds — delegating to shared round service', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns soroban round when service returns soroban source', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(SOROBAN_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('soroban');
    expect(Array.isArray(res.body.data.rounds)).toBe(true);
    expect(res.body.data.rounds).toHaveLength(1);
    expect(res.body.data.rounds[0].sorobanRoundId).toBe('1');
    expect(res.body.data.rounds[0].mode).toBe('UP_DOWN');
    expect(res.body.data.rounds[0].status).toBe('ACTIVE');
    expect(res.body.data.rounds[0].isSoroban).toBe(true);
  });

  it('falls back to mock rounds when soroban returns null', async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('mock');
    expect(Array.isArray(res.body.data.rounds)).toBe(true);
    expect(res.body.data.rounds).toHaveLength(getMockRounds().length);
    expect(mockGetActiveRound).toHaveBeenCalledTimes(1);
  });

  it('falls back to mock rounds when soroban throws', async () => {
    mockGetActiveRound.mockRejectedValueOnce(new Error('RPC unavailable'));
  it('returns mock rounds when service returns mock source', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('mock');
    expect(Array.isArray(res.body.data.rounds)).toBe(true);
  });

  it('response always uses envelope with success, data, source, and rounds', async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/rounds');

    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('source');
    expect(res.body.data).toHaveProperty('rounds');
    expect(res.body.success).toBe(true);
    expect(['soroban', 'mock']).toContain(res.body.data.source);
    expect(res.body.source).toBe('mock');
    expect(Array.isArray(res.body.rounds)).toBe(true);
    expect(res.body.rounds).toHaveLength(1);
  });

  it('response always includes source and rounds fields', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.body).toHaveProperty('source');
    expect(res.body).toHaveProperty('rounds');
    expect(['soroban', 'database', 'mock']).toContain(res.body.source);
  });

  it('propagates service errors to the error handler', async () => {
    mockGetRoundsForApi.mockRejectedValueOnce(new Error('Unexpected error'));

    const res = await request(app).get('/api/rounds');

  it('skips soroban entirely and returns mock source when ROUNDS_MOCK_MODE is true', async () => {
    process.env.ROUNDS_MOCK_MODE = 'true';

    // Re-evaluate config so it picks up the env var
    jest.isolateModules(() => {
      // config reads env at require-time; isolateModules gives a fresh scope
      const { createApp: freshCreateApp } = require('../app');
      const freshApp = freshCreateApp();

      return request(freshApp)
        .get('/api/rounds')
        .then((res: any) => {
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
          expect(res.body.data.source).toBe('mock');
          expect(mockGetActiveRound).not.toHaveBeenCalled();
        });
    });
    expect(res.status).toBe(500);
  });
});
