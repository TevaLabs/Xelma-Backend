import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';

// Mocks to ensure no actual network or DB calls happen
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: () => true,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  isReady: () => true,
  getHealth: jest.fn<any>().mockImplementation(async () => ({ data: { initialized: true } })),
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    isRunning: jest.fn<any>().mockImplementation(() => false),
    isStale: jest.fn<any>().mockImplementation(() => false),
    getLastUpdatedAt: jest.fn<any>().mockImplementation(() => null),
    getStalenessSeconds: jest.fn<any>().mockImplementation(() => null),
    getActiveSource: jest.fn<any>().mockImplementation(() => null),
  },
}));

jest.mock('../lib/redis', () => ({
  checkRedisHealth: jest.fn<any>().mockImplementation(async () => ({ status: 'healthy', durationMs: 1 })),
  isRedisCacheEnabled: () => false,
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn<any>().mockImplementation(async () => [{ '?column?': 1 }]),
  },
}));

import { createApp } from '../app';

describe('Liveness Health Probes (Issue #712)', () => {
  const app = createApp();

  it('GET /healthz returns instant status ok with zero IO', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.services).toBeUndefined();
  });

  it('GET /liveness returns instant status ok', async () => {
    const res = await request(app).get('/liveness');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /health?liveness=true returns liveness response', async () => {
    const res = await request(app).get('/api/health?liveness=true');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /health/ready returns detailed readiness with services', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('services');
  });
});
