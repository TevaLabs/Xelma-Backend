import { prisma } from '../lib/prisma';
import {
  getRateLimitCategory,
  OPERATOR_MONITORED_CATEGORIES,
  RateLimitCategory,
} from '../security/rate-limit-endpoints';

/**
 * Rate-limit metrics support two pluggable storage backends (issue #665):
 *
 * - `memory` — a bounded in-process buffer used whenever Prisma is not part of
 *   the runtime (hackathon / `DATA_MODE=mock` / `DATA_STORE=memory`) or when the
 *   configured Prisma backend becomes unreachable. Admin metrics stay populated
 *   instead of silently going empty.
 * - `prisma` — the production path. Behaviour is identical to the historical
 *   implementation so full Prisma mode is unchanged.
 *
 * Both implement {@link RateLimitMetricsBackend}, so callers never branch on the
 * active backend.
 */

export type RateLimitMetricsBackendKind = 'memory' | 'prisma';

/**
 * HTTP status recorded alongside a rate-limit increment.
 *
 * The rate limiter only records throttled requests today, so the value is
 * normally {@link RATE_LIMIT_HIT_STATUS} (429). The field is kept explicit so
 * other outcomes can be counted without a schema change in the memory backend.
 */
export type RateLimitMetricStatus = number;

/** Status persisted for a throttled request. */
export const RATE_LIMIT_HIT_STATUS = 429;

/** Storage-neutral rate-limit metric row. */
export interface RateLimitMetricRecord {
  endpoint: string;
  status: RateLimitMetricStatus;
  key: string;
  ip: string | null;
  userId: string | null;
  timestamp: Date;
}

export interface TopEndpoint {
  endpoint: string;
  hits: number;
}

export interface TopAbuser {
  key: string;
  endpoint: string;
  hits: number;
}

export interface CategoryActivitySummary {
  category: RateLimitCategory;
  hits: number;
  uniqueKeys: number;
  topEndpoints: TopEndpoint[];
}

export interface SuspiciousActor {
  key: string;
  endpoint: string;
  hits: number;
  category: RateLimitCategory;
  userId: string | null;
  ip: string | null;
  lastSeenAt: Date;
}

export interface SuspiciousActivityReport {
  lookbackHours: number;
  hitThreshold: number;
  byCategory: CategoryActivitySummary[];
  flaggedActors: SuspiciousActor[];
}

/**
 * Shape returned by `getSummary()` and served by
 * `GET /api/admin/metrics/rate-limits`.
 */
export interface RateLimitSummary {
  backend: RateLimitMetricsBackendKind;
  topEndpoints: TopEndpoint[];
  topAbusers: TopAbuser[];
  recentEvents: RateLimitMetricRecord[];
  suspiciousActivity: SuspiciousActivityReport;
}

/** One aggregated `route + status` bucket inside a snapshot. */
export interface RateLimitRouteSnapshot {
  route: string;
  status: RateLimitMetricStatus;
  hits: number;
}

/**
 * Compact, backend-agnostic view of the metrics, exposed by `snapshot()`.
 * The same shape is returned regardless of the active backend, which is what
 * makes the memory backend a drop-in replacement for Prisma.
 */
export interface RateLimitMetricsSnapshot {
  backend: RateLimitMetricsBackendKind;
  generatedAt: string;
  totalEvents: number;
  routes: RateLimitRouteSnapshot[];
  categories: CategoryActivitySummary[];
}

export interface RateLimitMetricsBackend {
  readonly kind: RateLimitMetricsBackendKind;
  /** Record a single increment for `record.endpoint` at `record.status`. */
  increment(record: RateLimitMetricRecord): Promise<void>;
  getSummary(limit: number): Promise<RateLimitSummary>;
  getSuspiciousActivity(limit: number): Promise<SuspiciousActivityReport>;
  snapshot(): Promise<RateLimitMetricsSnapshot>;
  clearOldMetrics(days: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Shared configuration + pure aggregation helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Minimum hits in the lookback window before an actor is flagged as suspicious */
export const SUSPICIOUS_HIT_THRESHOLD = parsePositiveInt(
  process.env.RATE_LIMIT_SUSPICIOUS_HIT_THRESHOLD,
  5,
);

/** Lookback window for suspicious-activity heuristics (hours) */
export const SUSPICIOUS_LOOKBACK_HOURS = parsePositiveInt(
  process.env.RATE_LIMIT_SUSPICIOUS_LOOKBACK_HOURS,
  24,
);

/** Upper bound on buffered in-memory records (prevents unbounded growth). */
export const DEFAULT_MEMORY_MAX_RECORDS = parsePositiveInt(
  process.env.RATE_LIMIT_METRICS_MEMORY_MAX,
  5000,
);

const DEFAULT_SNAPSHOT_LIMIT = 10;

function newestFirst(a: RateLimitMetricRecord, b: RateLimitMetricRecord): number {
  return b.timestamp.getTime() - a.timestamp.getTime();
}

function rankTopEndpoints(
  records: RateLimitMetricRecord[],
  limit: number,
): TopEndpoint[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.endpoint, (counts.get(record.endpoint) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([endpoint, hits]) => ({ endpoint, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}

function rankTopAbusers(
  records: RateLimitMetricRecord[],
  limit: number,
): TopAbuser[] {
  const counts = new Map<string, TopAbuser>();
  for (const record of records) {
    const groupKey = `${record.key}::${record.endpoint}`;
    const existing = counts.get(groupKey);
    if (existing) {
      existing.hits += 1;
    } else {
      counts.set(groupKey, {
        key: record.key,
        endpoint: record.endpoint,
        hits: 1,
      });
    }
  }
  return [...counts.values()].sort((a, b) => b.hits - a.hits).slice(0, limit);
}

function buildCategorySummaries(
  hits: Array<Pick<RateLimitMetricRecord, 'endpoint' | 'key'>>,
  limit: number,
): CategoryActivitySummary[] {
  const categoryMap = new Map<
    RateLimitCategory,
    { hits: number; keys: Set<string>; endpointCounts: Map<string, number> }
  >();

  for (const category of OPERATOR_MONITORED_CATEGORIES) {
    categoryMap.set(category, {
      hits: 0,
      keys: new Set(),
      endpointCounts: new Map(),
    });
  }

  for (const hit of hits) {
    const category = getRateLimitCategory(hit.endpoint);
    if (!OPERATOR_MONITORED_CATEGORIES.includes(category)) continue;

    const bucket = categoryMap.get(category)!;
    bucket.hits += 1;
    bucket.keys.add(hit.key);
    bucket.endpointCounts.set(
      hit.endpoint,
      (bucket.endpointCounts.get(hit.endpoint) ?? 0) + 1,
    );
  }

  return OPERATOR_MONITORED_CATEGORIES.map((category) => {
    const bucket = categoryMap.get(category)!;
    const topEndpoints = [...bucket.endpointCounts.entries()]
      .map(([endpoint, hitCount]) => ({ endpoint, hits: hitCount }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);

    return {
      category,
      hits: bucket.hits,
      uniqueKeys: bucket.keys.size,
      topEndpoints,
    };
  });
}

function buildFlaggedActors(
  hits: RateLimitMetricRecord[],
  limit: number,
): SuspiciousActor[] {
  const grouped = new Map<
    string,
    {
      endpoint: string;
      key: string;
      hits: number;
      userId: string | null;
      ip: string | null;
      lastSeenAt: Date;
    }
  >();

  for (const hit of hits) {
    const groupKey = `${hit.endpoint}::${hit.key}`;
    const existing = grouped.get(groupKey);
    if (!existing) {
      grouped.set(groupKey, {
        endpoint: hit.endpoint,
        key: hit.key,
        hits: 1,
        userId: hit.userId,
        ip: hit.ip,
        lastSeenAt: hit.timestamp,
      });
      continue;
    }

    existing.hits += 1;
    if (hit.timestamp > existing.lastSeenAt) {
      existing.lastSeenAt = hit.timestamp;
      existing.userId = hit.userId ?? existing.userId;
      existing.ip = hit.ip ?? existing.ip;
    }
  }

  return [...grouped.values()]
    .filter((entry) => entry.hits >= SUSPICIOUS_HIT_THRESHOLD)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((entry) => ({
      key: entry.key,
      endpoint: entry.endpoint,
      hits: entry.hits,
      category: getRateLimitCategory(entry.endpoint),
      userId: entry.userId,
      ip: entry.ip,
      lastSeenAt: entry.lastSeenAt,
    }));
}

function buildSuspiciousActivity(
  records: RateLimitMetricRecord[],
  limit: number,
): SuspiciousActivityReport {
  const since = new Date();
  since.setHours(since.getHours() - SUSPICIOUS_LOOKBACK_HOURS);

  const monitored = records.filter(
    (record) =>
      record.timestamp >= since &&
      OPERATOR_MONITORED_CATEGORIES.includes(getRateLimitCategory(record.endpoint)),
  );

  return {
    lookbackHours: SUSPICIOUS_LOOKBACK_HOURS,
    hitThreshold: SUSPICIOUS_HIT_THRESHOLD,
    byCategory: buildCategorySummaries(monitored, limit),
    flaggedActors: buildFlaggedActors(monitored, limit),
  };
}

function buildRouteSnapshots(
  records: RateLimitMetricRecord[],
): RateLimitRouteSnapshot[] {
  const buckets = new Map<string, RateLimitRouteSnapshot>();
  for (const record of records) {
    const groupKey = `${record.endpoint}::${record.status}`;
    const existing = buckets.get(groupKey);
    if (existing) {
      existing.hits += 1;
    } else {
      buckets.set(groupKey, {
        route: record.endpoint,
        status: record.status,
        hits: 1,
      });
    }
  }
  return [...buckets.values()].sort((a, b) => b.hits - a.hits);
}

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

/**
 * Bounded in-memory backend used for hackathon/demo mode and as the graceful
 * degradation target when Prisma is unreachable.
 */
export class MemoryRateLimitMetricsBackend implements RateLimitMetricsBackend {
  public readonly kind = 'memory' as const;

  private records: RateLimitMetricRecord[] = [];

  private readonly maxRecords: number;

  constructor(maxRecords: number = DEFAULT_MEMORY_MAX_RECORDS) {
    this.maxRecords = maxRecords;
  }

  async increment(record: RateLimitMetricRecord): Promise<void> {
    this.records.push(record);
    const overflow = this.records.length - this.maxRecords;
    if (overflow > 0) {
      // Drop the oldest records so the buffer stays bounded in long demos.
      this.records.splice(0, overflow);
    }
  }

  async getSummary(limit: number): Promise<RateLimitSummary> {
    return {
      backend: this.kind,
      topEndpoints: rankTopEndpoints(this.records, limit),
      topAbusers: rankTopAbusers(this.records, limit),
      recentEvents: [...this.records].sort(newestFirst).slice(0, limit * 2),
      suspiciousActivity: await this.getSuspiciousActivity(limit),
    };
  }

  async getSuspiciousActivity(limit: number): Promise<SuspiciousActivityReport> {
    return buildSuspiciousActivity(this.records, limit);
  }

  async snapshot(): Promise<RateLimitMetricsSnapshot> {
    return {
      backend: this.kind,
      generatedAt: new Date().toISOString(),
      totalEvents: this.records.length,
      routes: buildRouteSnapshots(this.records),
      categories: buildCategorySummaries(this.records, DEFAULT_SNAPSHOT_LIMIT),
    };
  }

  async clearOldMetrics(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const before = this.records.length;
    this.records = this.records.filter((record) => record.timestamp >= cutoff);
    return before - this.records.length;
  }

  /** Number of buffered records (test / introspection helper). */
  size(): number {
    return this.records.length;
  }

  /** Drop all buffered records (test helper). */
  reset(): void {
    this.records = [];
  }
}

// ---------------------------------------------------------------------------
// Prisma backend
// ---------------------------------------------------------------------------

type PrismaRateLimitRow = {
  endpoint: string;
  key: string;
  ip: string | null;
  userId: string | null;
  timestamp: Date;
};

function toRecord(row: PrismaRateLimitRow): RateLimitMetricRecord {
  return {
    endpoint: row.endpoint,
    // The RateLimitMetric model does not persist a status column; every stored
    // row is a throttled request, so 429 is the correct mapping.
    status: RATE_LIMIT_HIT_STATUS,
    key: row.key,
    ip: row.ip ?? null,
    userId: row.userId ?? null,
    timestamp: row.timestamp,
  };
}

/**
 * Production backend. Mirrors the original Prisma queries so full Prisma mode
 * behaves exactly as before, and only adds the backend `kind`/`status` fields.
 */
export class PrismaRateLimitMetricsBackend implements RateLimitMetricsBackend {
  public readonly kind = 'prisma' as const;

  async increment(record: RateLimitMetricRecord): Promise<void> {
    await prisma.rateLimitMetric.create({
      data: {
        endpoint: record.endpoint,
        key: record.key,
        ip: record.ip ?? undefined,
        userId: record.userId ?? undefined,
        timestamp: record.timestamp,
      },
    });
  }

  async getSummary(limit: number): Promise<RateLimitSummary> {
    const topEndpoints = (await prisma.rateLimitMetric.groupBy({
      by: ['endpoint'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    })) as unknown as Array<{ endpoint: string; _count: { id: number } }>;

    const recentEvents = (await prisma.rateLimitMetric.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit * 2,
    })) as unknown as PrismaRateLimitRow[];

    const topAbusers = (await prisma.rateLimitMetric.groupBy({
      by: ['key', 'endpoint'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    })) as unknown as Array<{
      key: string;
      endpoint: string;
      _count: { id: number };
    }>;

    return {
      backend: this.kind,
      topEndpoints: topEndpoints.map((entry) => ({
        endpoint: entry.endpoint,
        hits: entry._count.id,
      })),
      topAbusers: topAbusers.map((entry) => ({
        key: entry.key,
        endpoint: entry.endpoint,
        hits: entry._count.id,
      })),
      recentEvents: recentEvents.map(toRecord),
      suspiciousActivity: await this.getSuspiciousActivity(limit),
    };
  }

  async getSuspiciousActivity(limit: number): Promise<SuspiciousActivityReport> {
    const since = new Date();
    since.setHours(since.getHours() - SUSPICIOUS_LOOKBACK_HOURS);

    const rows = (await prisma.rateLimitMetric.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
    })) as unknown as PrismaRateLimitRow[];

    return buildSuspiciousActivity(rows.map(toRecord), limit);
  }

  async snapshot(): Promise<RateLimitMetricsSnapshot> {
    const grouped = (await prisma.rateLimitMetric.groupBy({
      by: ['endpoint'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    })) as unknown as Array<{ endpoint: string; _count: { id: number } }>;

    const routes: RateLimitRouteSnapshot[] = grouped.map((entry) => ({
      route: entry.endpoint,
      status: RATE_LIMIT_HIT_STATUS,
      hits: entry._count.id,
    }));

    const suspicious = await this.getSuspiciousActivity(DEFAULT_SNAPSHOT_LIMIT);

    return {
      backend: this.kind,
      generatedAt: new Date().toISOString(),
      totalEvents: routes.reduce((sum, route) => sum + route.hits, 0),
      routes,
      categories: suspicious.byCategory,
    };
  }

  async clearOldMetrics(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const result = await prisma.rateLimitMetric.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    return result.count;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Chooses the metrics backend from the runtime mode.
 *
 * Precedence:
 *   1. `RATE_LIMIT_METRICS_BACKEND` explicit override (`memory` | `prisma`).
 *   2. `DATA_STORE=memory` → memory.
 *   3. `DATA_MODE=mock` (with `DATA_STORE` unset) → memory.
 *   4. otherwise → Prisma.
 *
 * The service additionally degrades a failing Prisma backend to memory at
 * runtime, so hackathon demos keep reporting even when no database is wired up.
 */
export function resolveRateLimitMetricsBackendKind(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitMetricsBackendKind {
  const override = env.RATE_LIMIT_METRICS_BACKEND?.trim().toLowerCase();
  if (override === 'memory') return 'memory';
  if (override === 'prisma' || override === 'postgres') return 'prisma';

  if (env.DATA_STORE === 'memory') return 'memory';
  if (env.DATA_STORE === undefined && env.DATA_MODE === 'mock') return 'memory';

  return 'prisma';
}

export function createRateLimitMetricsBackend(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitMetricsBackend {
  return resolveRateLimitMetricsBackendKind(env) === 'memory'
    ? new MemoryRateLimitMetricsBackend()
    : new PrismaRateLimitMetricsBackend();
}
