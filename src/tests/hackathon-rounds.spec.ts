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
    expect(res.body.source).toBe('soroban');
    expect(Array.isArray(res.body.rounds)).toBe(true);
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0].sorobanRoundId).toBe('1');
    expect(res.body.rounds[0].mode).toBe('UP_DOWN');
    expect(res.body.rounds[0].status).toBe('ACTIVE');
    expect(res.body.rounds[0].isSoroban).toBe(true);
  });

  it('returns mock rounds when service returns mock source', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
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

    expect(res.status).toBe(500);
  });
});
