import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  MemoryRateLimitMetricsBackend,
  createRateLimitMetricsBackend,
  resolveRateLimitMetricsBackendKind,
  type RateLimitMetricsBackend,
} from '../services/rate-limit-metrics.backends';
import { RateLimitMetricsService } from '../services/rate-limit-metrics.service';

describe('rate-limit metrics backend selection', () => {
  it('selects memory for DATA_MODE=mock', () => {
    expect(resolveRateLimitMetricsBackendKind({ DATA_MODE: 'mock' })).toBe('memory');
  });

  it('selects memory for DATA_STORE=memory', () => {
    expect(resolveRateLimitMetricsBackendKind({ DATA_STORE: 'memory' })).toBe('memory');
  });

  it('selects memory for DATA_STORE=memory even when DATA_MODE=live', () => {
    expect(
      resolveRateLimitMetricsBackendKind({ DATA_MODE: 'live', DATA_STORE: 'memory' }),
    ).toBe('memory');
  });

  it('selects prisma for full mode', () => {
    expect(resolveRateLimitMetricsBackendKind({ DATA_MODE: 'live' })).toBe('prisma');
    expect(resolveRateLimitMetricsBackendKind({})).toBe('prisma');
  });

  it('honours the RATE_LIMIT_METRICS_BACKEND override', () => {
    expect(
      resolveRateLimitMetricsBackendKind({ DATA_MODE: 'live', RATE_LIMIT_METRICS_BACKEND: 'memory' }),
    ).toBe('memory');
    expect(
      resolveRateLimitMetricsBackendKind({ DATA_MODE: 'mock', RATE_LIMIT_METRICS_BACKEND: 'prisma' }),
    ).toBe('prisma');
  });

  it('creates the matching backend instance', () => {
    expect(createRateLimitMetricsBackend({ DATA_MODE: 'mock' }).kind).toBe('memory');
    expect(createRateLimitMetricsBackend({ DATA_MODE: 'live' }).kind).toBe('prisma');
  });
});

describe('MemoryRateLimitMetricsBackend', () => {
  let backend: MemoryRateLimitMetricsBackend;

  beforeEach(() => {
    backend = new MemoryRateLimitMetricsBackend();
  });

  it('increments and reports a snapshot grouped by route + status', async () => {
    await backend.increment({
      endpoint: 'auth/connect',
      status: 429,
      key: 'ip-1',
      ip: '1.2.3.4',
      userId: null,
      timestamp: new Date(),
    });
    await backend.increment({
      endpoint: 'auth/connect',
      status: 429,
      key: 'ip-1',
      ip: '1.2.3.4',
      userId: null,
      timestamp: new Date(),
    });
    await backend.increment({
      endpoint: 'prediction/submit',
      status: 429,
      key: 'user-1',
      ip: null,
      userId: 'user-1',
      timestamp: new Date(),
    });

    const snapshot = await backend.snapshot();

    expect(snapshot.backend).toBe('memory');
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.routes).toEqual([
      { route: 'auth/connect', status: 429, hits: 2 },
      { route: 'prediction/submit', status: 429, hits: 1 },
    ]);
    const auth = snapshot.categories.find((c) => c.category === 'auth');
    expect(auth?.hits).toBe(2);
  });

  it('ranks top endpoints and abusers in getSummary', async () => {
    for (let i = 0; i < 3; i++) {
      await backend.increment({
        endpoint: 'chat/message',
        status: 429,
        key: 'user-1',
        ip: null,
        userId: 'user-1',
        timestamp: new Date(),
      });
    }
    await backend.increment({
      endpoint: 'auth/connect',
      status: 429,
      key: 'ip-9',
      ip: '9.9.9.9',
      userId: null,
      timestamp: new Date(),
    });

    const summary = await backend.getSummary(10);

    expect(summary.backend).toBe('memory');
    expect(summary.topEndpoints[0]).toEqual({ endpoint: 'chat/message', hits: 3 });
    expect(summary.topAbusers[0]).toEqual({
      key: 'user-1',
      endpoint: 'chat/message',
      hits: 3,
    });
    expect(summary.recentEvents).toHaveLength(4);
  });

  it('flags repeat offenders in suspicious activity', async () => {
    for (let i = 0; i < 5; i++) {
      await backend.increment({
        endpoint: 'auth/connect',
        status: 429,
        key: 'ip-1',
        ip: '1.2.3.4',
        userId: null,
        timestamp: new Date(),
      });
    }

    const suspicious = await backend.getSuspiciousActivity(10);

    expect(suspicious.byCategory).toHaveLength(3);
    expect(suspicious.flaggedActors).toHaveLength(1);
    expect(suspicious.flaggedActors[0]).toMatchObject({
      endpoint: 'auth/connect',
      key: 'ip-1',
      hits: 5,
      category: 'auth',
    });
  });

  it('bounds the buffer to the configured maximum', async () => {
    const bounded = new MemoryRateLimitMetricsBackend(3);
    for (let i = 0; i < 10; i++) {
      await bounded.increment({
        endpoint: 'api/general',
        status: 429,
        key: `ip-${i}`,
        ip: `10.0.0.${i}`,
        userId: null,
        timestamp: new Date(),
      });
    }

    const snapshot = await bounded.snapshot();
    expect(snapshot.totalEvents).toBe(3);
    expect(bounded.size()).toBe(3);
  });

  it('clears metrics older than the retention window', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const recentDate = new Date();

    await backend.increment({
      endpoint: 'api/general',
      status: 429,
      key: 'old',
      ip: null,
      userId: null,
      timestamp: oldDate,
    });
    await backend.increment({
      endpoint: 'api/general',
      status: 429,
      key: 'recent',
      ip: null,
      userId: null,
      timestamp: recentDate,
    });

    const deleted = await backend.clearOldMetrics(7);

    expect(deleted).toBe(1);
    expect(backend.size()).toBe(1);
  });
});

describe('RateLimitMetricsService in memory mode', () => {
  it('records increments and returns a snapshot through the backend', async () => {
    const service = new RateLimitMetricsService(new MemoryRateLimitMetricsBackend());

    await service.increment('auth/challenge', 429, { key: 'ip-1', ip: '1.2.3.4' });
    await service.recordHit({ endpoint: 'auth/challenge', key: 'ip-2', ip: '5.6.7.8' });

    const snapshot = await service.snapshot();
    expect(service.backendKind).toBe('memory');
    expect(snapshot.totalEvents).toBe(2);
    expect(snapshot.routes[0]).toEqual({
      route: 'auth/challenge',
      status: 429,
      hits: 2,
    });
  });

  it('degrades a failing Prisma-style backend to memory', async () => {
    const failing: RateLimitMetricsBackend = {
      kind: 'prisma',
      increment: async () => {
        throw new Error('db down');
      },
      getSummary: async () => {
        throw new Error('db down');
      },
      getSuspiciousActivity: async () => {
        throw new Error('db down');
      },
      snapshot: async () => {
        throw new Error('db down');
      },
      clearOldMetrics: async () => {
        throw new Error('db down');
      },
    };

    const service = new RateLimitMetricsService(failing);

    await service.increment('auth/connect', 429, { key: 'ip-1' });

    expect(service.backendKind).toBe('memory');
    const snapshot = await service.snapshot();
    expect(snapshot.totalEvents).toBe(1);
  });
});
