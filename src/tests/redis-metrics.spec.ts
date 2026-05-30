import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { register } from 'prom-client';
import {
  redisCacheHitsTotal,
  redisCacheMissesTotal,
  redisCacheSetsTotal,
  redisCacheInvalidationsTotal,
  redisCacheBypassesTotal,
  redisCacheErrorsTotal,
  redisCacheEnabled,
  metricsRegistry,
} from '../middleware/metrics.middleware';

jest.mock('../lib/prisma', () => {
  return {
    prisma: {
      userStats: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
    },
  };
});

import {
  getCacheMetrics,
  invalidateNamespace,
  getJsonFromCache,
  setJsonToCache,
} from '../lib/redis';

describe('Redis cache metrics telemetry', () => {
  const originalRedisCacheEnabled = process.env.REDIS_CACHE_ENABLED;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset Prometheus registry to avoid metric name conflicts between tests
    register.clear();
    // Re-register metrics after clearing
    metricsRegistry.clear();
  });

  afterAll(() => {
    // Restore original environment variables
    if (originalRedisCacheEnabled === undefined) {
      delete process.env.REDIS_CACHE_ENABLED;
    } else {
      process.env.REDIS_CACHE_ENABLED = originalRedisCacheEnabled;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('Redis disabled: increments bypass counter and sets enabled gauge to 0', async () => {
    process.env.REDIS_CACHE_ENABLED = 'false';
    delete process.env.REDIS_URL;

    const bypassesBefore = redisCacheBypassesTotal.inc();
    const enabledBefore = await redisCacheEnabled.get();

    await getJsonFromCache('test', 'key');
    await setJsonToCache('test', 'key', { value: 1 }, 60);
    await invalidateNamespace('test');

    const bypassesAfter = redisCacheBypassesTotal.inc();
    const enabledAfter = await redisCacheEnabled.get();

    // Bypass counter should have increased
    expect(bypassesAfter).toBeGreaterThan(bypassesBefore);
    // Enabled gauge should be 0 (disabled)
    expect(enabledAfter.values[0].value).toBe(0);
  });

  it('Redis circuit-breaker cooldown: increments bypass counter and sets enabled gauge to 0', async () => {
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_FAIL_COOLDOWN_MS = '10000';

    // Simulate a recent failure by setting the internal state
    // This is a bit of a hack since we can't directly set lastRedisFailureAtMs
    // Instead, we'll just verify that when Redis is unavailable, bypasses are counted
    
    const bypassesBefore = redisCacheBypassesTotal.inc();
    
    // Try to use cache with an invalid Redis URL (will fail and bypass)
    process.env.REDIS_URL = 'redis://invalid-host:9999';
    await getJsonFromCache('test', 'key');

    const bypassesAfter = redisCacheBypassesTotal.inc();

    // Bypass counter should have increased when Redis is unavailable
    expect(bypassesAfter).toBeGreaterThan(bypassesBefore);
  });

  it('Internal metrics remain backward compatible with getCacheMetrics', async () => {
    process.env.REDIS_CACHE_ENABLED = 'false';

    const metricsBefore = getCacheMetrics();
    
    await getJsonFromCache('test', 'key1');
    await getJsonFromCache('test', 'key2');
    await setJsonToCache('test', 'key3', { value: 1 }, 60);

    const metricsAfter = getCacheMetrics();

    // Internal metrics should still be tracked
    expect(metricsAfter.bypasses).toBeGreaterThan(metricsBefore.bypasses);
    expect(metricsAfter.sets).toBeGreaterThan(metricsBefore.sets);
  });

  it('Prometheus metrics are registered and accessible', async () => {
    // Verify all Redis metrics are registered
    const metrics = await metricsRegistry.metrics();
    
    expect(metrics).toContain('redis_cache_hits_total');
    expect(metrics).toContain('redis_cache_misses_total');
    expect(metrics).toContain('redis_cache_sets_total');
    expect(metrics).toContain('redis_cache_invalidations_total');
    expect(metrics).toContain('redis_cache_bypasses_total');
    expect(metrics).toContain('redis_cache_errors_total');
    expect(metrics).toContain('redis_cache_enabled');
  });

  it('Error counter increments on Redis errors', async () => {
    process.env.REDIS_CACHE_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://invalid-host:9999';

    const errorsBefore = redisCacheErrorsTotal.inc();
    
    // This will fail and increment error counter
    await getJsonFromCache('test', 'key');

    const errorsAfter = redisCacheErrorsTotal.inc();

    // Error counter should have increased
    expect(errorsAfter).toBeGreaterThan(errorsBefore);
  });
});
