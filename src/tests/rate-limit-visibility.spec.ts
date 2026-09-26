/**
 * Admin metrics / rate-limit visibility tests.
 *
 * Fully offline: Prisma is mocked (the rate-limit metrics service also keeps an
 * in-memory fallback) and the rate limiters are passthroughs, so this suite runs
 * in the fast unit project without PostgreSQL or Redis.
 *
 * The table-driven matrix below is the security contract: every admin metrics
 * path must return 401 without a token, 403 for a USER, and 200 for an ADMIN.
 * The final block asserts the hackathon app cannot expose them — neither by
 * default nor when the `adminRoutes` factory flag is forced on.
 */
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../index';
import { createApp as createHackathonApp } from '../app';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';
import { rateLimitMetricsService } from '../services/rate-limit-metrics.service';

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async ({ where }: { where?: { id?: string } } = {}) => {
        if (where?.id === 'admin-user-id') {
          return {
            id: 'admin-user-id',
            walletAddress: 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            role: 'ADMIN',
          };
        }
        if (where?.id === 'regular-user-id') {
          return {
            id: 'regular-user-id',
            walletAddress: 'GUSERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            role: 'USER',
          };
        }
        return null;
      }),
    },
    rateLimitMetric: {
      create: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    claim: { groupBy: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../middleware/rateLimiter.middleware', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    apiRateLimiter: passthrough,
    writeRateLimiter: passthrough,
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
    chatMessageRateLimiter: passthrough,
    predictionRateLimiter: passthrough,
    batchPredictionRateLimiter: passthrough,
    batchLeaderboardRateLimiter: passthrough,
    adminRoundRateLimiter: passthrough,
    oracleResolveRateLimiter: passthrough,
    betRateLimiter: passthrough,
  };
});

const ADMIN_USER = {
  id: 'admin-user-id',
  walletAddress: 'GADMINWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  role: UserRole.ADMIN,
};
const REGULAR_USER = {
  id: 'regular-user-id',
  walletAddress: 'GUSERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  role: UserRole.USER,
};

const adminToken = generateToken(
  ADMIN_USER.id,
  ADMIN_USER.walletAddress,
  UserRole.ADMIN,
);
const userToken = generateToken(
  REGULAR_USER.id,
  REGULAR_USER.walletAddress,
  UserRole.USER,
);

/**
 * Every admin metrics path, in one table. The auth matrix below walks this
 * list so a new admin-metrics route cannot ship without a 401/403 guarantee,
 * and the hackathon assertions make sure the factory `adminRoutes` flag
 * cannot accidentally expose limiter/user-activity numbers on the demo app.
 */
const ADMIN_METRICS_ROUTES: ReadonlyArray<{
  name: string;
  method: 'get' | 'post';
  path: string;
}> = [
  { name: 'rate-limits summary', method: 'get', path: '/api/admin/metrics/rate-limits' },
  { name: 'rate-limits clear', method: 'post', path: '/api/admin/metrics/rate-limits/clear' },
  { name: 'prometheus scrape', method: 'get', path: '/api/admin/metrics/metrics' },
  { name: 'payout reconciliation', method: 'get', path: '/api/admin/metrics/payout-reconciliation' },
  { name: 'rate-limit summary', method: 'get', path: '/api/admin/metrics/rate-limit-summary' },
];

describe('Rate Limit Visibility', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
    rateLimitMetricsService.resetInMemoryStore();
  });

  it('records a rate-limit hit and surfaces it in the summary', async () => {
    await rateLimitMetricsService.recordHit({
      endpoint: 'test/endpoint',
      key: 'test-key',
      ip: '127.0.0.1',
      userId: REGULAR_USER.id,
    });

    const summary = await rateLimitMetricsService.getSummary(10);

    expect(
      summary.recentEvents.some(
        (event: { endpoint: string; key: string }) =>
          event.endpoint === 'test/endpoint' && event.key === 'test-key',
      ),
    ).toBe(true);
  });

  it('should expose rate limit metrics to admins', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limits')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('topEndpoints');
    expect(response.body).toHaveProperty('topAbusers');
    expect(response.body).toHaveProperty('recentEvents');
    expect(response.body).toHaveProperty('suspiciousActivity');
    expect(response.body.suspiciousActivity).toHaveProperty('byCategory');
    expect(response.body.suspiciousActivity).toHaveProperty('flaggedActors');
  });

  it('should deny access to rate limit metrics for regular users', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limits')
      .set('Authorization', `Bearer ${userToken}`);

    expect(response.status).toBe(403);
  });

  it('should deny access to rate limit metrics for unauthenticated users', async () => {
    const response = await request(app).get('/api/admin/metrics/rate-limits');

    expect(response.status).toBe(401);
  });

  it('should allow admins to clear old metrics', async () => {
    const response = await request(app)
      .post('/api/admin/metrics/rate-limits/clear?days=0')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('deletedCount');
  });

  it('should record a rate limit hit in Prometheus', async () => {
    const { RateLimitMetricsService } = require('../services/rate-limit-metrics.service');
    const { register } = require('prom-client');

    const testEndpoint = 'test/prom-endpoint';
    const testMethod = 'POST';

    RateLimitMetricsService.recordHit(testEndpoint, testMethod);

    const metric = register.getSingleMetric('http_rate_limit_hits_total');
    expect(metric).toBeDefined();
    const valueObj = await metric.get();
    const match = valueObj.values.find(
      (v: { labels: Record<string, string> }) =>
        v.labels.endpoint === testEndpoint && v.labels.method === testMethod,
    );
    expect(match).toBeDefined();
    expect(match.value).toBeGreaterThanOrEqual(1);
  });

  it('should expose Prometheus metrics via scraping endpoint to admins', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/metrics')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('http_rate_limit_hits_total');
  });

  it('should expose rate-limit-summary JSON to admins', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limit-summary')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('metric', 'http_rate_limit_hits_total');
    expect(response.body).toHaveProperty('summary');
    expect(Array.isArray(response.body.summary)).toBe(true);

    const match = response.body.summary.find(
      (s: { endpoint: string; method: string }) =>
        s.endpoint === 'test/prom-endpoint' && s.method === 'POST',
    );
    expect(match).toBeDefined();
    expect(match.hits).toBeGreaterThanOrEqual(1);
  });

  it('should deny rate-limit-summary to regular users', async () => {
    const response = await request(app)
      .get('/api/admin/metrics/rate-limit-summary')
      .set('Authorization', `Bearer ${userToken}`);

    expect(response.status).toBe(403);
  });

  // ── Table-driven auth matrix for every admin metrics route ────────────────
  // No token ⇒ 401, USER role ⇒ 403, ADMIN role ⇒ 200 for every path, so a
  // new route cannot quietly ship without role protection.
  describe('admin metrics auth matrix', () => {
    it.each(ADMIN_METRICS_ROUTES)(
      '$name ($method $path) returns 401 without a token',
      async ({ method, path }) => {
        const response = await request(app)[method](path);

        expect(response.status).toBe(401);
      },
    );

    it.each(ADMIN_METRICS_ROUTES)(
      '$name ($method $path) returns 403 for a USER role',
      async ({ method, path }) => {
        const response = await request(app)
          [method](path)
          .set('Authorization', `Bearer ${userToken}`);

        expect(response.status).toBe(403);
      },
    );

    it.each(ADMIN_METRICS_ROUTES)(
      '$name ($method $path) returns 200 for an ADMIN role',
      async ({ method, path }) => {
        const response = await request(app)
          [method](path)
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
      },
    );
  });
});

// ── Hackathon exposure ──────────────────────────────────────────────────────
// The hackathon app must never serve admin metrics by default, and must still
// reject unauthenticated callers even if the `adminRoutes` flag is forced on.
describe('Admin metrics exposure on the hackathon app', () => {
  it('does not mount any admin metrics route by default', async () => {
    const hackathonApp = createHackathonApp();

    for (const { method, path } of ADMIN_METRICS_ROUTES) {
      const response = await request(hackathonApp)[method](path);

      expect(response.status).toBe(404);
    }
  });

  it('still returns 401 when the adminRoutes flag is forced on', async () => {
    const hackathonApp = createHackathonApp({ features: { adminRoutes: true } });

    for (const { method, path } of ADMIN_METRICS_ROUTES) {
      const response = await request(hackathonApp)[method](path);

      expect(response.status).toBe(401);
    }
  });
});
