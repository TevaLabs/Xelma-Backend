import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../app';

const mockGetRoundsForApi = jest.fn();
const mockGetActiveRound = jest.fn();

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: {
    getRoundsForApi: (...args: any[]) => mockGetRoundsForApi(...args),
  },
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    getActiveRound: (...args: any[]) => mockGetActiveRound(...args),
    isReady: jest.fn().mockReturnValue(false),
    getUserStats: jest.fn(),
    getPendingWinnings: jest.fn(),
    getBalance: jest.fn(),
    getHealth: jest.fn(),
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

jest.mock('../middleware/rateLimiter.middleware', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { apiRateLimiter: pass, writeRateLimiter: pass, betRateLimiter: pass, adminRoundRateLimiter: pass, oracleResolveRateLimiter: pass, challengeRateLimiter: pass, connectRateLimiter: pass, authRateLimiter: pass, chatMessageRateLimiter: pass, predictionRateLimiter: pass, batchPredictionRateLimiter: pass, batchLeaderboardRateLimiter: pass };
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

const DATABASE_ROUND_RESPONSE = {
  source: 'database',
  rounds: [
    {
      id: 'db-round-1',
      mode: 'UP_DOWN',
      status: 'ACTIVE',
      startPrice: 0.5,
      source: 'database',
    },
  ],
};

const MOCK_ROUND_RESPONSE = {
  source: 'mock',
  rounds: [
    {
      id: 'btc-updown-live',
      asset: 'XLM',
      mode: 'updown',
      status: 'live',
      startPrice: 0.5,
      poolUp: 100,
      poolDown: 200,
      closesAt: new Date(Date.now() + 3600000).toISOString(),
      source: 'mock',
    },
  ],
};

describe('GET /api/rounds — delegating to shared round service', () => {
  let app: Express;

  beforeEach(() => {
    mockGetActiveRound.mockRejectedValue(new Error('RPC unavailable'));
    mockGetRoundsForApi.mockResolvedValue(MOCK_ROUND_RESPONSE);
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the on-chain round when the service resolves the soroban source', async () => {
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
    expect(res.body.data.rounds[0].source).toBe('soroban');
  });

  it('never substitutes fabricated mock rounds into a soroban-sourced response', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(SOROBAN_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.body.data.source).toBe('soroban');
    expect(
      res.body.data.rounds.every((round: any) => round.source === 'soroban')
    ).toBe(true);
  });

  it('returns database rounds when the service falls back to the database source', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(DATABASE_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('database');
    expect(res.body.data.rounds).toHaveLength(1);
    expect(res.body.data.rounds[0].id).toBe('db-round-1');
    expect(res.body.data.rounds[0].source).toBe('database');
  });

  it('returns mock rounds when the service falls back to the mock source', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('mock');
    expect(Array.isArray(res.body.data.rounds)).toBe(true);
    expect(res.body.data.rounds[0].source).toBe('mock');
  });

  it('delegates sourcing to the shared service exactly once per request', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(SOROBAN_ROUND_RESPONSE);

    await request(app).get('/api/rounds');

    expect(mockGetRoundsForApi).toHaveBeenCalledTimes(1);
  });

  it('response always uses envelope with success, data, source, and rounds', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('source');
    expect(res.body.data).toHaveProperty('rounds');
    expect(res.body.success).toBe(true);
    expect(['soroban', 'database', 'mock']).toContain(res.body.data.source);
  });

  it('keeps source and rounds inside the data envelope (not duplicated at top level)', async () => {
    mockGetRoundsForApi.mockResolvedValueOnce(MOCK_ROUND_RESPONSE);

    const res = await request(app).get('/api/rounds');

    // Contract: { success, data: { source, rounds } } — the mock payload is
    // nested under data and never mirrored at the top level. Money fields are
    // serialized to fixed-precision strings by the route.
    expect(res.body.success).toBe(true);
    expect(res.body.data.source).toBe('mock');
    expect(Array.isArray(res.body.data.rounds)).toBe(true);
    expect(res.body.data.rounds[0]).toMatchObject({
      id: MOCK_ROUND_RESPONSE.rounds[0].id,
      mode: MOCK_ROUND_RESPONSE.rounds[0].mode,
      source: 'mock',
    });
    expect(res.body.data.rounds[0].poolUp).toBe('100.00000000');
    expect(res.body).not.toHaveProperty('source');
    expect(res.body).not.toHaveProperty('rounds');
  });

  it('propagates service errors to the error handler', async () => {
    mockGetRoundsForApi.mockRejectedValueOnce(new Error('Unexpected error'));

    const res = await request(app).get('/api/rounds');

    expect(res.status).toBe(500);
  });
});
