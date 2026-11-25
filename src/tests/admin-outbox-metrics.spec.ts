import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const mockGroupBy: any = jest.fn();
const mockFindFirst: any = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    outboxEvent: {
      groupBy: (...args: any[]) => mockGroupBy(...args),
      findFirst: (...args: any[]) => mockFindFirst(...args),
    },
  },
}));

jest.mock('@prisma/client', () => ({
  OutboxEventStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
  },
}));

jest.mock('../middleware/auth.middleware', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireMetricsAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/rate-limit-metrics.service', () => ({
  rateLimitMetricsService: {
    getSummary: jest.fn(),
    clearOldMetrics: jest.fn(),
  },
}));

jest.mock('../services/payout-reconciliation.service', () => ({
  __esModule: true,
  default: {
    getReconciliationSummary: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import adminMetricsRouter from '../routes/admin-metrics.routes';

const app = express();
app.use('/api/admin/metrics', adminMetricsRouter);

describe('GET /api/admin/metrics/outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns counts by status and oldest backlog age', async () => {
    const oldestCreatedAt = new Date(Date.now() - 125_000);
    mockGroupBy.mockResolvedValueOnce([
      { status: 'PENDING', _count: { _all: 4 } },
      { status: 'PROCESSING', _count: { _all: 1 } },
      { status: 'PROCESSED', _count: { _all: 20 } },
      { status: 'FAILED', _count: { _all: 2 } },
    ]);
    mockFindFirst.mockResolvedValueOnce({
      id: 'outbox-1',
      status: 'PENDING',
      createdAt: oldestCreatedAt,
    });

    const res = await request(app).get('/api/admin/metrics/outbox');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.countsByStatus).toEqual({
      PENDING: 4,
      PROCESSING: 1,
      PROCESSED: 20,
      FAILED: 2,
    });
    expect(res.body.total).toBe(27);
    expect(res.body.backlogCount).toBe(5);
    expect(res.body.oldestAgeSeconds).toBeGreaterThanOrEqual(124);
    expect(res.body.oldestAgeSeconds).toBeLessThanOrEqual(130);
    expect(res.body.oldestBacklogEvent).toMatchObject({
      id: 'outbox-1',
      status: 'PENDING',
      createdAt: oldestCreatedAt.toISOString(),
    });
    expect(res.body.oldestBacklogEvent.ageSeconds).toBe(res.body.oldestAgeSeconds);
    expect(res.body.oldestBacklogEvent.ageMs).toBeGreaterThanOrEqual(124_000);
  });

  it('returns zero counts and null oldest age when outbox has no backlog', async () => {
    mockGroupBy.mockResolvedValueOnce([
      { status: 'PROCESSED', _count: { _all: 10 } },
    ]);
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/admin/metrics/outbox');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      countsByStatus: {
        PENDING: 0,
        PROCESSING: 0,
        PROCESSED: 10,
        FAILED: 0,
      },
      total: 10,
      backlogCount: 0,
      oldestAgeSeconds: null,
      oldestBacklogEvent: null,
    });
  });

  it('returns 500 when database query fails', async () => {
    mockGroupBy.mockRejectedValueOnce(new Error('DB connection lost'));
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/admin/metrics/outbox');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal Server Error',
      message: 'Failed to fetch outbox backlog metrics',
    });
  });
});
