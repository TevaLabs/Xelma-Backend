/**
 * Assertion test: both hackathon and production apps produce the same
 * HTTP request log shape (method, path, status, durationMs, requestId).
 *
 * Run:  npx jest src/tests/http-logger-unified.spec.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

const mockLogInfo = jest.fn();

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mocks required by the production app (index.ts)
jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: { getActiveRound: jest.fn().mockResolvedValue(null), isReady: jest.fn().mockReturnValue(false) },
}));

// Both apps are now built by the same factory, so importing either one loads
// every router — including src/routes/rounds.ts (betRateLimiter) and
// src/routes/auth.routes.ts (challengeRateLimiter / authRateLimiter). An
// omitted export here surfaces as "Route.post() requires a callback function
// but got a [object Undefined]" at import time.
jest.mock('../middleware/rateLimiter.middleware', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    apiRateLimiter: pass,
    writeRateLimiter: pass,
    betRateLimiter: pass,
    challengeRateLimiter: pass,
    connectRateLimiter: pass,
    authRateLimiter: pass,
    predictionRateLimiter: pass,
    batchPredictionRateLimiter: pass,
    batchLeaderboardRateLimiter: pass,
    adminRoundRateLimiter: pass,
    oracleResolveRateLimiter: pass,
    chatMessageRateLimiter: pass,
  };
});

// The shared rounds router falls back to the mock tier (mockData.repository →
// prisma.mockRound) when Soroban and the DB are unavailable, so the prisma
// mock must provide those models or GET /api/rounds 500s. $queryRaw keeps the
// /api/health DB probe happy too.
jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: async () => null,
    mockRound: {
      findMany: async () => [
        {
          id: 'btc-updown-live',
          asset: 'BTC',
          mode: 'updown',
          status: 'live',
          startPrice: 60000,
          poolUp: 0,
          poolDown: 0,
          totalPool: null,
          predictionCount: null,
          closesAt: new Date(Date.now() + 300_000).toISOString(),
        },
      ],
      findUnique: async () => null,
    },
    mockLeaderboard: { findMany: async () => [] },
    mockPlatformStat: { findFirst: async () => null },
  },
}));

const EXPECTED_FIELDS = ['method', 'path', 'status', 'durationMs', 'requestId'];

function getLastHttpLog(): Record<string, any> | undefined {
  const calls = mockLogInfo.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === 'http request') {
      return calls[i][1];
    }
  }
  return undefined;
}

describe('HTTP request log shape is identical across apps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('hackathon app (src/app.ts)', () => {
    it('logs every expected field on GET /api/rounds', async () => {
      const { createApp } = await import('../app');
      const app = createApp();

      await request(app).get('/api/rounds');

      const log = getLastHttpLog();
      expect(log).toBeDefined();

      for (const field of EXPECTED_FIELDS) {
        expect(log).toHaveProperty(field);
      }

      expect(log!.method).toBe('GET');
      expect(log!.path).toBe('/api/rounds');
      expect(typeof log!.status).toBe('number');
      expect(typeof log!.durationMs).toBe('number');
      expect(typeof log!.requestId).toBe('string');
    });

    it('includes requestId even without client header', async () => {
      const { createApp } = await import('../app');
      const app = createApp();

      await request(app).get('/api/health');

      const log = getLastHttpLog();
      expect(log!.requestId).toBeTruthy();
    });

    it('propagates client X-Request-ID header into requestId field', async () => {
      const { createApp } = await import('../app');
      const app = createApp();

      await request(app).get('/api/health').set('X-Request-ID', 'client-trace-1');

      const log = getLastHttpLog();
      expect(log!.requestId).toBe('client-trace-1');
    });

    it('logs the correct status code', async () => {
      const { createApp } = await import('../app');
      const app = createApp();

      await request(app).get('/api/rounds');

      const log = getLastHttpLog();
      expect([200, 304]).toContain(log!.status);
    });
  });

  describe('production app (src/index.ts)', () => {
    it('logs every expected field on GET /api/health', async () => {
      // The production module has side effects on import; isolate to avoid
      // polluting the test runner's global state.
      jest.isolateModules(async () => {
        process.env.NODE_ENV = 'test';
        process.env.DATA_MODE = 'mock';
        process.env.JWT_SECRET = 'test-jwt-secret-for-production';
        process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

        jest.clearAllMocks();

        const { createApp } = await import('../index');

        const app = createApp();
        await request(app).get('/api/health');

        const log = getLastHttpLog();
        expect(log).toBeDefined();

        for (const field of EXPECTED_FIELDS) {
          expect(log).toHaveProperty(field);
        }

        expect(log!.method).toBe('GET');
        expect(typeof log!.status).toBe('number');
        expect(typeof log!.durationMs).toBe('number');
        expect(typeof log!.requestId).toBe('string');
      });
    });
  });

  describe('log field consistency', () => {
    it('both apps produce the same set of log fields', async () => {
      jest.isolateModules(async () => {
        process.env.NODE_ENV = 'test';
        process.env.DATA_MODE = 'mock';
        process.env.JWT_SECRET = 'test-jwt-secret-for-production';
        process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

        jest.clearAllMocks();

        const { createApp: createFullApp } = await import('../index');
        const fullApp = createFullApp();
        await request(fullApp).get('/api/health');
        const fullLog = getLastHttpLog();
        const fullKeys = fullLog ? Object.keys(fullLog).filter(k => k !== 'cachedAt') : [];

        jest.clearAllMocks();

        const { createApp: createHackathonApp } = await import('../app');
        const hackApp = createHackathonApp();
        await request(hackApp).get('/api/health');
        const hackLog = getLastHttpLog();
        const hackKeys = hackLog ? Object.keys(hackLog).filter(k => k !== 'cachedAt') : [];

        for (const key of EXPECTED_FIELDS) {
          expect(fullKeys).toContain(key);
          expect(hackKeys).toContain(key);
        }

        // Verify the two log shapes have the same fields
        expect(fullKeys.sort()).toEqual(hackKeys.sort());
      });
    });
  });
});
