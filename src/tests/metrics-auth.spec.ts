/**
 * Unit tests for the Prometheus scrape auth guards (Issue #636).
 *
 * GET /metrics was previously mounted with no auth at all, exposing process
 * internals and route histograms on any publicly reachable deployment.
 * `requirePublicMetricsAuth` (used only by the public /metrics route) adds a
 * local/dev/test convenience bypass on top of the always-strict
 * `requireMetricsAuth` (also used by the admin dashboard's duplicate scrape
 * route, which must never allow anonymous access — see
 * rate-limit-visibility.spec.ts's admin metrics auth matrix).
 *
 * These tests exercise both middlewares directly (rather than the full app)
 * against a mocked config + Prisma so METRICS_SCRAPE_TOKEN and NODE_ENV can
 * be flipped per scenario without touching real env vars.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { UserRole } from '@prisma/client';

const mockConfigState: {
  metricsScrapeToken: string;
  nodeEnv: 'development' | 'production' | 'test';
} = {
  metricsScrapeToken: '',
  nodeEnv: 'test',
};

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    app: {
      get metricsScrapeToken() {
        return mockConfigState.metricsScrapeToken;
      },
      get nodeEnv() {
        return mockConfigState.nodeEnv;
      },
    },
  },
}));

const mockUserFindUnique = jest.fn();
jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireMetricsAuth, requirePublicMetricsAuth } = require('../middleware/auth.middleware');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateToken } = require('../utils/jwt.util');

function buildApp(middleware: typeof requirePublicMetricsAuth) {
  const app = express();
  app.get('/metrics', middleware, (_req: any, res: any) => res.status(200).json({ ok: true }));
  return app;
}

describe('requirePublicMetricsAuth (public GET /metrics) (#636)', () => {
  beforeEach(() => {
    mockConfigState.metricsScrapeToken = '';
    mockConfigState.nodeEnv = 'test';
    mockUserFindUnique.mockReset();
  });

  it('allows anonymous scrape when no token is configured outside production (dev)', async () => {
    mockConfigState.nodeEnv = 'development';
    const res = await request(buildApp(requirePublicMetricsAuth)).get('/metrics');
    expect(res.status).toBe(200);
  });

  it('allows anonymous scrape when no token is configured outside production (test)', async () => {
    mockConfigState.nodeEnv = 'test';
    const res = await request(buildApp(requirePublicMetricsAuth)).get('/metrics');
    expect(res.status).toBe(200);
  });

  it('rejects anonymous scrape in production when no token is configured', async () => {
    mockConfigState.nodeEnv = 'production';
    const res = await request(buildApp(requirePublicMetricsAuth)).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('allows a request bearing the correct METRICS_SCRAPE_TOKEN in production', async () => {
    mockConfigState.nodeEnv = 'production';
    mockConfigState.metricsScrapeToken = 'super-secret-scrape-token';

    const res = await request(buildApp(requirePublicMetricsAuth))
      .get('/metrics')
      .set('Authorization', 'Bearer super-secret-scrape-token');

    expect(res.status).toBe(200);
  });

  it('rejects a request with the wrong token in production', async () => {
    mockConfigState.nodeEnv = 'production';
    mockConfigState.metricsScrapeToken = 'super-secret-scrape-token';

    const res = await request(buildApp(requirePublicMetricsAuth))
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token');

    expect(res.status).toBe(401);
  });

  it('requires the token outside production too once one is configured (no silent bypass)', async () => {
    mockConfigState.nodeEnv = 'development';
    mockConfigState.metricsScrapeToken = 'super-secret-scrape-token';

    const res = await request(buildApp(requirePublicMetricsAuth)).get('/metrics');

    expect(res.status).toBe(401);
  });

  it('allows a valid Admin JWT as a fallback in production when no token is configured', async () => {
    mockConfigState.nodeEnv = 'production';
    mockUserFindUnique.mockResolvedValue({
      id: 'admin-1',
      walletAddress: 'GADMIN_METRICS_TEST_AAAAAAAAAAAAAA',
      role: UserRole.ADMIN,
    });
    const token = generateToken('admin-1', 'GADMIN_METRICS_TEST_AAAAAAAAAAAAAA', UserRole.ADMIN);

    const res = await request(buildApp(requirePublicMetricsAuth))
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('rejects a non-admin JWT in production when no token is configured', async () => {
    mockConfigState.nodeEnv = 'production';
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      walletAddress: 'GUSER_METRICS_TEST_AAAAAAAAAAAAAAA',
      role: UserRole.USER,
    });
    const token = generateToken('user-1', 'GUSER_METRICS_TEST_AAAAAAAAAAAAAAA', UserRole.USER);

    const res = await request(buildApp(requirePublicMetricsAuth))
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('requireMetricsAuth (shared with the admin dashboard scrape route) (#636)', () => {
  beforeEach(() => {
    mockConfigState.metricsScrapeToken = '';
    mockConfigState.nodeEnv = 'test';
    mockUserFindUnique.mockReset();
  });

  it('never allows anonymous scrape, even outside production, unlike requirePublicMetricsAuth', async () => {
    mockConfigState.nodeEnv = 'development';
    const res = await request(buildApp(requireMetricsAuth)).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('allows a request bearing the correct METRICS_SCRAPE_TOKEN', async () => {
    mockConfigState.metricsScrapeToken = 'super-secret-scrape-token';
    const res = await request(buildApp(requireMetricsAuth))
      .get('/metrics')
      .set('Authorization', 'Bearer super-secret-scrape-token');
    expect(res.status).toBe(200);
  });
});
