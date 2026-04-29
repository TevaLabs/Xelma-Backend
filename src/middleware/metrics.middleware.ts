import { Request, Response, NextFunction } from 'express';
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import { connectionRegistry } from '../socket';
import config from '../config';

export const metricsRegistry = new Registry();

// Default Node.js process metrics (memory, CPU, event loop lag, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ---------------------------------------------------------------------------
// HTTP metrics
// ---------------------------------------------------------------------------

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP 4xx/5xx responses',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Service-level metrics
// ---------------------------------------------------------------------------

export const socketConnectionsActive = new Gauge({
  name: 'socket_connections_active',
  help: 'Number of currently active Socket.IO connections',
  registers: [metricsRegistry],
  collect() {
    this.set(connectionRegistry.size);
  },
});

export const roundsStartedTotal = new Counter({
  name: 'rounds_started_total',
  help: 'Total number of rounds started',
  labelNames: ['mode'] as const,
  registers: [metricsRegistry],
});

export const roundsResolvedTotal = new Counter({
  name: 'rounds_resolved_total',
  help: 'Total number of rounds resolved',
  labelNames: ['mode'] as const,
  registers: [metricsRegistry],
});

export const predictionsPlacedTotal = new Counter({
  name: 'predictions_placed_total',
  help: 'Total number of predictions placed',
  registers: [metricsRegistry],
});

export const priceOracleUpdatesTotal = new Counter({
  name: 'price_oracle_updates_total',
  help: 'Total number of price oracle updates fetched',
  registers: [metricsRegistry],
});

export const circuitBreakerStateChangesTotal = new Counter({
  name: 'circuit_breaker_state_changes_total',
  help: 'Total number of circuit breaker state transitions',
  labelNames: ['breaker', 'from_state', 'to_state', 'reason'] as const,
  registers: [metricsRegistry],
});

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Current circuit breaker state as one-hot labels',
  labelNames: ['breaker', 'state'] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// DB / Prisma pool settings (low-cardinality)
// ---------------------------------------------------------------------------

export const dbPoolSettingsInfo = new Gauge({
  name: 'db_pool_settings_info',
  help: 'Effective DB pool/timeout settings (labels), value is always 1',
  labelNames: [
    'connection_limit',
    'pool_timeout_seconds',
    'connect_timeout_seconds',
    'statement_timeout_ms',
    'pgbouncer',
  ] as const,
  registers: [metricsRegistry],
  collect() {
    this.set(
      {
        connection_limit: String(config.database.connectionLimit),
        pool_timeout_seconds: String(config.database.poolTimeoutSeconds),
        connect_timeout_seconds: String(config.database.connectTimeoutSeconds),
        statement_timeout_ms: String(config.database.statementTimeoutMs),
        pgbouncer: String(config.database.pgbouncer),
      },
      1,
    );
  },
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
