import {
   Registry,
   collectDefaultMetrics,
   Counter,
   Histogram,
   Gauge,
} from 'prom-client';
import config from '../config';
import { getCacheMetrics } from '../lib/redis';

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

/**
 * Oracle health gauges (#229).
 *
 * These let dashboards/alerting reason about price freshness directly,
 * complementing the per-fetch counters above and the JSON view at /health.
 * They are updated imperatively by the PriceOracle on every poll cycle and
 * on start/stop, so they stay current even while upstream fetches are
 * failing (the staleness value keeps climbing each poll).
 */
export const oracleUp = new Gauge({
   name: 'oracle_up',
   help: '1 when the oracle is polling and holds a fresh (non-stale) price, else 0',
   registers: [metricsRegistry],
});

export const oracleLastUpdateTimestampSeconds = new Gauge({
   name: 'oracle_last_update_timestamp_seconds',
   help: 'Unix timestamp (seconds) of the last successful oracle price update; 0 if never updated',
   registers: [metricsRegistry],
});

export const oraclePriceStalenessSeconds = new Gauge({
   name: 'oracle_price_staleness_seconds',
   help: 'Age in seconds of the current oracle price; -1 when no price has been fetched yet',
   registers: [metricsRegistry],
});

/**
 * Counts resolve attempts refused because the price feed was not safe to
 * settle against. `reason` is a low-cardinality label (e.g. stale_price,
 * invalid_price).
 */
export const oracleResolveBlockedTotal = new Counter({
   name: 'oracle_resolve_blocked_total',
   help: 'Total round-resolution attempts blocked by oracle safety guards',
   labelNames: ['reason'] as const,
   registers: [metricsRegistry],
});

/**
 * Snapshot of the oracle's freshness, supplied by the PriceOracle.
 * `lastUpdateUnixSeconds` is null when no successful fetch has happened.
 */
export interface OracleHealthSnapshot {
   running: boolean;
   hasPrice: boolean;
   stale: boolean;
   stalenessSeconds: number | null;
   lastUpdateUnixSeconds: number | null;
}

/**
 * Push the oracle's current health into the Prometheus gauges. Called by
 * the PriceOracle rather than via a collect() callback to avoid a circular
 * import between this module and the oracle service.
 */
export function recordOracleHealth(snapshot: OracleHealthSnapshot): void {
   oracleUp.set(snapshot.running && snapshot.hasPrice && !snapshot.stale ? 1 : 0);
   oracleLastUpdateTimestampSeconds.set(snapshot.lastUpdateUnixSeconds ?? 0);
   oraclePriceStalenessSeconds.set(
      snapshot.stalenessSeconds === null ? -1 : snapshot.stalenessSeconds
   );
}

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

export const redisCacheHitsTotal = new Gauge({
   name: 'redis_cache_hits_total',
   help: 'Total Redis cache hits',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().hits);
   }
});

export const redisCacheMissesTotal = new Gauge({
   name: 'redis_cache_misses_total',
   help: 'Total Redis cache misses',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().misses);
   }
});

export const redisCacheSetsTotal = new Gauge({
   name: 'redis_cache_sets_total',
   help: 'Total Redis cache sets',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().sets);
   }
});

export const redisCacheInvalidationsTotal = new Gauge({
   name: 'redis_cache_invalidations_total',
   help: 'Total Redis cache invalidations',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().invalidations);
   }
});

export const redisCacheBypassesTotal = new Gauge({
   name: 'redis_cache_bypasses_total',
   help: 'Total Redis cache bypasses',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().bypasses);
   }
});

export const redisCacheErrorsTotal = new Gauge({
   name: 'redis_cache_errors_total',
   help: 'Total Redis cache errors',
   registers: [metricsRegistry],
   collect() {
      this.set(getCacheMetrics().errors);
   }
});

export const redisCacheHitRatio = new Gauge({
   name: 'redis_cache_hit_ratio',
   help: 'Current Redis cache hit ratio (hits / (hits + misses))',
   registers: [metricsRegistry],
   collect() {
      const m = getCacheMetrics();
      const total = m.hits + m.misses;
      this.set(total > 0 ? m.hits / total : 0);
   }
});
