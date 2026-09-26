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

/**
 * Payout reconciliation worker (Issue #492).
 *
 * These make stuck-payout sweeps observable: how many claim txs the worker
 * submits, how claims resolve, and how many are flagged for operator review.
 * `payoutClaimsInFlight` is refreshed by the worker after every run.
 *
 * Alert-worthy:
 * - `payout_claims_flagged_total{reason="chain_reverted"}` > 0 — the contract
 *   rejected a claim; an operator must investigate before any further retry.
 * - `payout_claims_in_flight{status="NEEDS_MANUAL_REVIEW"}` sustained — the
 *   sweeper is stuck and needs human action.
 */
export const payoutClaimsSubmittedTotal = new Counter({
   name: 'payout_claims_submitted_total',
   help: 'Payout claim transactions submitted, by source (user endpoint or worker)',
   labelNames: ['source'] as const,
   registers: [metricsRegistry],
});

export const payoutClaimsResolvedTotal = new Counter({
   name: 'payout_claims_resolved_total',
   help: 'Payout claims resolved to a terminal state by the reconciliation worker',
   labelNames: ['outcome'] as const,
   registers: [metricsRegistry],
});

export const payoutClaimsFlaggedTotal = new Counter({
   name: 'payout_claims_flagged_total',
   help: 'Payout claims flagged NEEDS_MANUAL_REVIEW (max_attempts, chain_reverted)',
   labelNames: ['reason'] as const,
   registers: [metricsRegistry],
});

export const payoutClaimsInFlight = new Gauge({
   name: 'payout_claims_in_flight',
   help: 'Open payout claims by status (PENDING, SUBMITTED, FAILED, NEEDS_MANUAL_REVIEW, ...)',
   labelNames: ['status'] as const,
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

/**
 * Soroban RPC call latency histogram.
 *
 * Measures end-to-end duration (including retries and circuit-breaker
 * overhead) for every Soroban contract call grouped by operation name.
 *
 * Buckets are chosen to cover the 15 s timeout range:
 *   fast reads (< 1 s), moderate writes (1–5 s), slow/hanging (5–15 s+)
 */
export const sorobanRpcDurationSeconds = new Histogram({
   name: 'soroban_rpc_duration_seconds',
   help: 'Duration of Soroban RPC calls in seconds',
   labelNames: ['operation'] as const,
   buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 7.5, 10, 15],
   registers: [metricsRegistry],
});

/**
 * Total Soroban RPC calls labelled by operation name and outcome.
 *
 * outcome is one of:
 *   success  — the call completed and the contract returned a value
 *   failure  — the call failed (timeout, connection error, contract revert)
 *   breaker_open — the circuit breaker was open, call was skipped
 */
export const sorobanRpcCallsTotal = new Counter({
   name: 'soroban_rpc_calls_total',
   help: 'Total number of Soroban RPC calls',
   labelNames: ['operation', 'outcome'] as const,
   registers: [metricsRegistry],
});

export const rateLimitHitsTotal = new Counter({
   name: 'rate_limit_hits_total',
   help: 'Total HTTP 429 responses from express-rate-limit handlers',
   labelNames: ['endpoint', 'category'] as const,
   registers: [metricsRegistry],
});

export const rateLimitStoreFallbacksTotal = new Counter({
   name: 'rate_limit_store_fallbacks_total',
   help: 'Requests counted by the per-process fallback window because the Redis-backed rate-limit store was unreachable (Issue #520)',
   labelNames: ['limiter'] as const,
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

/**
 * Distributed lock metrics (Issue #601).
 *
 * These make single-leader behaviour observable across replicas. `lock` is the
 * fixed job name (create-round, oracle-resolve-rounds, ...), so cardinality is
 * bounded by the number of scheduled jobs.
 *
 * Expected steady state on an N-replica deploy: one `acquired` and N-1 `denied`
 * per tick, a flat stream of `renewed`, and zero `stolen`/`expired`.
 *
 * Alert-worthy:
 * - `distributed_lock_lost_total{reason="stolen"}` > 0 — two instances briefly
 *   believed they were the leader; the TTL is too short for the heartbeat, or
 *   the event loop stalled.
 * - `distributed_lock_acquisitions_total{outcome="unavailable"}` climbing — Redis
 *   is down and every replica is now skipping the job (fail-closed).
 * - `distributed_lock_acquisitions_total{outcome="unlocked"}` > 0 on a
 *   multi-replica deploy — REDIS_URL is missing and jobs are running unguarded.
 */
export const distributedLockAcquisitionsTotal = new Counter({
   name: 'distributed_lock_acquisitions_total',
   help: 'Distributed lock acquisition attempts by lock name and outcome (acquired, denied, denied_local, unavailable, unlocked, error)',
   labelNames: ['lock', 'outcome'] as const,
   registers: [metricsRegistry],
});

export const distributedLockRenewalsTotal = new Counter({
   name: 'distributed_lock_renewals_total',
   help: 'Distributed lock heartbeat renewals by lock name and outcome (renewed, stolen, expired, error)',
   labelNames: ['lock', 'outcome'] as const,
   registers: [metricsRegistry],
});

export const distributedLockLostTotal = new Counter({
   name: 'distributed_lock_lost_total',
   help: 'Times a held distributed lock was lost mid-job, by reason (stolen, expired, redis_error, max_hold_exceeded)',
   labelNames: ['lock', 'reason'] as const,
   registers: [metricsRegistry],
});

export const distributedLocksHeld = new Gauge({
   name: 'distributed_locks_held',
   help: 'Number of distributed locks currently held by this instance, by lock name',
   labelNames: ['lock'] as const,
   registers: [metricsRegistry],
});

export const distributedLockHeldSeconds = new Histogram({
   name: 'distributed_lock_held_seconds',
   help: 'How long distributed locks were held, in seconds. Compare against the lock TTL when tuning.',
   labelNames: ['lock'] as const,
   buckets: [0.05, 0.25, 1, 5, 15, 30, 60, 120, 300, 600],
   registers: [metricsRegistry],
});

/**
 * Tournament saga violations (Issue #502).
 *
 * Incremented whenever a tournament lifecycle transition (create -> join ->
 * lock -> settle -> payout, plus cancel) is rejected as out-of-order — e.g.
 * locking a COMPLETED tournament or settling one that was never locked.
 * `from`/`to` are low-cardinality status labels, so this metric stays
 * alert-able without exploding cardinality. A sustained nonzero rate means
 * clients are driving the saga out of order and should be fixed.
 */
export const tournamentTransitionFailuresTotal = new Counter({
   name: 'tournament_transition_failures_total',
   help: 'Total tournament lifecycle transitions rejected as out-of-order',
   labelNames: ['from', 'to'] as const,
   registers: [metricsRegistry],
});

/**
 * Round state-machine violations (round lifecycle engine).
 *
 * Incremented whenever a round lifecycle transition (PENDING -> ACTIVE ->
 * LOCKED -> RESOLVED, plus cancel) is rejected as out-of-order or loses a
 * compare-and-set race. `from`/`to` are low-cardinality status labels.
 */
export const roundTransitionFailuresTotal = new Counter({
   name: 'round_transition_failures_total',
   help: 'Total round lifecycle transitions rejected as out-of-order',
   labelNames: ['from', 'to'] as const,
   registers: [metricsRegistry],
});
