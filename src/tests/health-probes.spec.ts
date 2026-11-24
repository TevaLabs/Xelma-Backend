import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockQueryRaw = jest.fn<() => Promise<unknown>>();
const mockCheckRedisHealth = jest.fn<() => Promise<{ status: string; durationMs: number }>>();
const mockSorobanGetHealth = jest.fn<() => { initialized: boolean }>();
const mockOracleIsRunning = jest.fn<() => boolean>();

jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...(args as [])),
  },
}));

jest.mock('../lib/redis', () => ({
  checkRedisHealth: () => mockCheckRedisHealth(),
  isRedisCacheEnabled: () => false,
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    getHealth: () => mockSorobanGetHealth(),
    isReady: () => false,
  },
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    isRunning: () => mockOracleIsRunning(),
    isStale: () => false,
    getLastUpdatedAt: () => null,
    getStalenessSeconds: () => null,
    getActiveSource: () => null,
  },
}));

import healthRouter from '../routes/health';

function createHealthTestApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('Health probes: liveness vs readiness (#1059)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockCheckRedisHealth.mockResolvedValue({ status: 'healthy', durationMs: 1 });
    mockSorobanGetHealth.mockReturnValue({ initialized: true });
    mockOracleIsRunning.mockReturnValue(false);
  });

  it('GET /health/live returns 200 alive without touching DB, Redis, Soroban, or Oracle', async () => {
    mockQueryRaw.mockRejectedValue(new Error('DB down'));
    const app = createHealthTestApp();

    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.data.status).toBe('alive');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockCheckRedisHealth).not.toHaveBeenCalled();
    expect(mockSorobanGetHealth).not.toHaveBeenCalled();
    expect(mockOracleIsRunning).not.toHaveBeenCalled();
  });

  it('GET /health/ready runs dependency probes and reports healthy when all pass', async () => {
    const app = createHealthTestApp();

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.services.database.status).toBe('healthy');
    expect(mockQueryRaw).toHaveBeenCalled();
    expect(mockCheckRedisHealth).toHaveBeenCalled();
    expect(mockSorobanGetHealth).toHaveBeenCalled();
  });

  it('GET /health/ready reports unhealthy when database probe fails', async () => {
    mockQueryRaw.mockRejectedValue(new Error('connection refused'));
    const app = createHealthTestApp();

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('unhealthy');
    expect(res.body.data.services.database.status).toBe('unhealthy');
  });
});

