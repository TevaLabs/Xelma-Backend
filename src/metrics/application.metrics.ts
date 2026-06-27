import {
   Registry,
   collectDefaultMetrics,
   Counter,
   Histogram,
   Gauge,
} from 'prom-client';
import config from '../config';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

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

export const socketConnectionsActive = new Gauge({
   name: 'socket_connections_active',
   help: 'Number of currently active Socket.IO connections',
   registers: [metricsRegistry],
});

export function setSocketConnectionsActive(count: number): void {
   socketConnectionsActive.set(count);
}

export const websocketEmitsTotal = new Counter({
   name: 'websocket_emits_total',
   help: 'Total number of WebSocket emit attempts',
   labelNames: ['event', 'outcome'] as const,
   registers: [metricsRegistry],
});

export const websocketConnectionEventsTotal = new Counter({
   name: 'websocket_connection_events_total',
   help: 'Total Socket.IO connection lifecycle events',
   labelNames: ['event', 'authenticated'] as const,
   registers: [metricsRegistry],
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
   help: 'Total number of successful price oracle updates fetched',
   labelNames: ['provider'] as const,
   registers: [metricsRegistry],
});

export const priceOracleFetchFailuresTotal = new Counter({
   name: 'price_oracle_fetch_failures_total',
   help: 'Total number of failed price oracle fetch attempts',
   labelNames: ['reason', 'provider'] as const,
   registers: [metricsRegistry],
});

export const schedulerRunsTotal = new Counter({
   name: 'scheduler_runs_total',
   help: 'Total scheduler job executions by fixed job name and outcome',
   labelNames: ['job', 'outcome'] as const,
   registers: [metricsRegistry],
});

export const schedulerItemsProcessedTotal = new Counter({
   name: 'scheduler_items_processed_total',
   help: 'Total items processed by scheduler jobs',
   labelNames: ['job', 'outcome'] as const,
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

export const rateLimitHitsTotal = new Counter({
   name: 'rate_limit_hits_total',
   help: 'Total HTTP 429 responses from express-rate-limit handlers',
   labelNames: ['endpoint', 'category'] as const,
   registers: [metricsRegistry],
});

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
         1
      );
   },
});
