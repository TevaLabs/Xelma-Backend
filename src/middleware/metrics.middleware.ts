import { Request, Response, NextFunction } from 'express';
import {
  httpErrorsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from '../metrics/application.metrics';

export * from '../metrics/application.metrics';

// ---------------------------------------------------------------------------
// Redis cache metrics
// ---------------------------------------------------------------------------

export const redisCacheHitsTotal = new Counter({
  name: 'redis_cache_hits_total',
  help: 'Total number of Redis cache hits',
  registers: [metricsRegistry],
});

export const redisCacheMissesTotal = new Counter({
  name: 'redis_cache_misses_total',
  help: 'Total number of Redis cache misses',
  registers: [metricsRegistry],
});

export const redisCacheSetsTotal = new Counter({
  name: 'redis_cache_sets_total',
  help: 'Total number of Redis cache set operations',
  registers: [metricsRegistry],
});

export const redisCacheInvalidationsTotal = new Counter({
  name: 'redis_cache_invalidations_total',
  help: 'Total number of Redis cache namespace invalidations',
  registers: [metricsRegistry],
});

export const redisCacheBypassesTotal = new Counter({
  name: 'redis_cache_bypasses_total',
  help: 'Total number of cache bypasses (Redis unavailable or disabled)',
  registers: [metricsRegistry],
});

export const redisCacheErrorsTotal = new Counter({
  name: 'redis_cache_errors_total',
  help: 'Total number of Redis cache operation errors',
  registers: [metricsRegistry],
});

export const redisCacheEnabled = new Gauge({
  name: 'redis_cache_enabled',
  help: 'Whether Redis cache is currently enabled (1) or bypassed (0)',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Normalizes dynamic Express route params so labels don't have unbounded
 * cardinality (e.g. /api/rounds/abc123 → /api/rounds/:id).
 */
function normalizeRoute(req: Request): string {
  return req.route?.path
    ? `${req.baseUrl ?? ''}${req.route.path}`
    : req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationSeconds = Number(durationNs) / 1e9;

    const labels = {
      method: req.method,
      route: normalizeRoute(req),
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);

    if (res.statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }
  });

  next();
}
