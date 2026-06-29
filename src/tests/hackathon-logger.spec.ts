import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../app';

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: (...args: any[]) => mockLogWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    getActiveRound: jest.fn().mockResolvedValue(null),
    isReady: jest.fn().mockReturnValue(false),
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

// Prevent real Prisma / DB connection in unit tests
jest.mock('../lib/prisma', () => ({ prisma: {} }));

describe('Winston structured logging in hackathon app', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('logs HTTP requests with method, path, status, and durationMs', async () => {
    await request(app).get('/api/rounds');

    const httpLogCall = mockLogInfo.mock.calls.find(
      (call) => call[0] === 'http request',
    );
    expect(httpLogCall).toBeDefined();
    const meta = httpLogCall![1];
    expect(meta).toHaveProperty('method', 'GET');
    expect(meta).toHaveProperty('path', '/api/rounds');
    expect(meta).toHaveProperty('status');
    expect(typeof meta.durationMs).toBe('number');
  });

  it('includes a requestId correlation ID in every HTTP log entry', async () => {
    await request(app).get('/api/rounds');

    const httpLogCall = mockLogInfo.mock.calls.find(
      (call) => call[0] === 'http request',
    );
    expect(httpLogCall).toBeDefined();
    const meta = httpLogCall![1];
    expect(typeof meta.requestId).toBe('string');
    expect(meta.requestId.length).toBeGreaterThan(0);
  });

  it('propagates X-Request-ID header from client as requestId', async () => {
    const correlationId = 'test-correlation-id-abc123';
    await request(app).get('/api/rounds').set('X-Request-ID', correlationId);

    const httpLogCall = mockLogInfo.mock.calls.find(
      (call) => call[0] === 'http request',
    );
    expect(httpLogCall).toBeDefined();
    expect(httpLogCall![1].requestId).toBe(correlationId);
  });

  it('sets X-Request-ID response header', async () => {
    const res = await request(app).get('/api/rounds');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('logger module is defined and exposes level-aware methods', () => {
    const logger = require('../utils/logger').default;
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
