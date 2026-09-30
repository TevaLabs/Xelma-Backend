import logger from '../utils/logger';
import { Counter, register } from 'prom-client';
import {
  createRateLimitMetricsBackend,
  MemoryRateLimitMetricsBackend,
  RATE_LIMIT_HIT_STATUS,
  type RateLimitMetricRecord,
  type RateLimitMetricsBackend,
  type RateLimitMetricsBackendKind,
} from './rate-limit-metrics.backends';

export type {
  CategoryActivitySummary,
  RateLimitMetricsSnapshot,
  RateLimitRouteSnapshot,
  RateLimitSummary,
  SuspiciousActor,
  SuspiciousActivityReport,
  TopAbuser,
  TopEndpoint,
} from './rate-limit-metrics.backends';

const counterName = 'http_rate_limit_hits_total';
let httpRateLimitHitsTotal = register.getSingleMetric(counterName) as Counter<string>;

if (!httpRateLimitHitsTotal) {
  httpRateLimitHitsTotal = new Counter({
    name: counterName,
    help: 'Total HTTP 429 rate limit hits',
    labelNames: ['endpoint', 'method'] as const,
    registers: [register],
  });
}

/** Optional per-increment context (who/where the throttle happened). */
export interface RateLimitHitContext {
  key?: string;
  ip?: string | null;
  userId?: string | null;
  timestamp?: Date;
}

/**
 * Facade over a pluggable rate-limit-metrics backend (issue #665).
 *
 * The write path is `increment(route, status)` and the read path is
 * `snapshot()` (see {@link RateLimitMetricsSnapshot}); `getSummary()` /
 * `getSuspiciousActivity()` / `clearOldMetrics()` preserve the pre-existing API
 * used by the admin routes and the rate-limiter middleware.
 *
 * The backend is chosen by `DATA_MODE` / `DATA_STORE`
 * (`createRateLimitMetricsBackend`) and degrades from Prisma to memory if the
 * database becomes unreachable, so admin metrics never silently go empty.
 */
export class RateLimitMetricsService {
  private backend: RateLimitMetricsBackend;

  constructor(backend?: RateLimitMetricsBackend) {
    this.backend = backend ?? createRateLimitMetricsBackend();
  }

  /** Active backend kind (`memory` | `prisma`). */
  public get backendKind(): RateLimitMetricsBackendKind {
    return this.backend.kind;
  }

  /**
   * Records a Prometheus rate-limit hit.
   */
  public static recordHit(endpoint: string, method: string): void {
    try {
      httpRateLimitHitsTotal.inc({ endpoint, method });
    } catch (error) {
      logger.error('Failed to record Prometheus rate-limit hit:', error);
    }
  }

  /**
   * Records a rate-limit increment for `route` with the given HTTP `status`.
   *
   * The increment is written to the selected backend only (never duplicated
   * across backends), so Prisma-mode summaries are not double-counted.
   */
  async increment(
    route: string,
    status: number = RATE_LIMIT_HIT_STATUS,
    context: RateLimitHitContext = {},
  ): Promise<void> {
    const record: RateLimitMetricRecord = {
      endpoint: route,
      status,
      key: context.key ?? context.ip ?? 'unknown',
      ip: context.ip ?? null,
      userId: context.userId ?? null,
      timestamp: context.timestamp ?? new Date(),
    };

    try {
      await this.runWithFallback((backend) => backend.increment(record));
    } catch (error) {
      logger.error('Failed to record rate-limit increment:', error);
    }
  }

  /**
   * Records a rate-limit hit. Thin wrapper over {@link increment} kept for the
   * rate-limiter middleware call site.
   */
  async recordHit(data: {
    endpoint: string;
    key: string;
    ip?: string;
    userId?: string;
  }): Promise<void> {
    await this.increment(data.endpoint, RATE_LIMIT_HIT_STATUS, {
      key: data.key,
      ip: data.ip ?? null,
      userId: data.userId ?? null,
    });
  }

  /** Retrieves summary statistics for rate-limit hits. */
  async getSummary(limit: number = 10) {
    try {
      return await this.runWithFallback((backend) => backend.getSummary(limit));
    } catch (error) {
      logger.error('Failed to get rate-limit summary:', error);
      throw error;
    }
  }

  /**
   * Operator-facing view of auth, prediction, and chat rate-limit abuse patterns.
   */
  async getSuspiciousActivity(limit: number = 10) {
    return this.runWithFallback((backend) => backend.getSuspiciousActivity(limit));
  }

  /**
   * Compact, backend-independent snapshot of current counters. See
   * {@link RateLimitMetricsSnapshot} for the documented shape.
   */
  async snapshot() {
    return this.runWithFallback((backend) => backend.snapshot());
  }

  /**
   * Clears old metrics (optional, for maintenance).
   */
  async clearOldMetrics(days: number = 7): Promise<number> {
    try {
      return await this.runWithFallback((backend) => backend.clearOldMetrics(days));
    } catch (error) {
      logger.error('Failed to clear old rate-limit metrics:', error);
      return 0;
    }
  }

  /**
   * Runs an operation against the active backend. If the Prisma backend throws
   * (database unreachable / dropped mid-flight) the service permanently
   * degrades to the bounded in-memory backend and retries once, mirroring the
   * "select by DATA_MODE or Prisma connectivity" requirement.
   */
  private async runWithFallback<T>(
    operation: (backend: RateLimitMetricsBackend) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(this.backend);
    } catch (error) {
      if (this.backend.kind !== 'prisma') throw error;

      logger.warn(
        'Rate-limit metrics Prisma backend unavailable; degrading to in-memory backend',
        { error: error instanceof Error ? error.message : String(error) },
      );
      this.backend = new MemoryRateLimitMetricsBackend();
      return operation(this.backend);
    }
  }
}

export const rateLimitMetricsService = new RateLimitMetricsService();
