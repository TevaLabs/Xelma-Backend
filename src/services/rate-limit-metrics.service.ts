import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import {
  getRateLimitCategory,
  OPERATOR_MONITORED_CATEGORIES,
  RateLimitCategory,
} from '../security/rate-limit-endpoints';
import { Counter, register } from 'prom-client';

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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Minimum hits in the lookback window before an actor is flagged as suspicious */
const SUSPICIOUS_HIT_THRESHOLD = parsePositiveInt(
  process.env.RATE_LIMIT_SUSPICIOUS_HIT_THRESHOLD,
  5,
);

/** Lookback window for suspicious-activity heuristics (hours) */
const SUSPICIOUS_LOOKBACK_HOURS = parsePositiveInt(
  process.env.RATE_LIMIT_SUSPICIOUS_LOOKBACK_HOURS,
  24,
);

export interface CategoryActivitySummary {
  category: RateLimitCategory;
  hits: number;
  uniqueKeys: number;
  topEndpoints: Array<{ endpoint: string; hits: number }>;
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

// ---------------------------------------------------------------------------
// In-memory storage backend for hackathon / demo mode when Prisma is not
// available. Keeps the same API surface so callers never need to know which
// backend is active.
// ---------------------------------------------------------------------------

interface InMemoryMetricRecord {
  endpoint: string;
  key: string;
  ip: string | null;
  userId: string | null;
  timestamp: Date;
}

const inMemoryStore: InMemoryMetricRecord[] = [];

/** Try a Prisma call; returns the fallback value if Prisma is unavailable. */
async function withPrismaFallback<T>(
  prismaFn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await prismaFn();
  } catch (error) {
    logger.warn('Prisma unavailable for rate-limit metrics, using in-memory fallback:', error);
    return fallback;
  }
}

function combineWithMemoryRecords(dbRecords: InMemoryMetricRecord[]): InMemoryMetricRecord[] {
  return [...inMemoryStore, ...dbRecords];
}

export class RateLimitMetricsService {
  /**
   * Records a Prometheus rate-limit hit
   */
  public static recordHit(endpoint: string, method: string): void {
    try {
      httpRateLimitHitsTotal.inc({ endpoint, method });
    } catch (error) {
      logger.error('Failed to record Prometheus rate-limit hit:', error);
    }
  }

  /**
   * Records a rate-limit hit in the database, falling back to in-memory
   * storage when Prisma is unavailable (e.g. hackathon mock mode).
   */
  async recordHit(data: {
    endpoint: string;
    key: string;
    ip?: string;
    userId?: string;
  }): Promise<void> {
    const record: InMemoryMetricRecord = {
      endpoint: data.endpoint,
      key: data.key,
      ip: data.ip ?? null,
      userId: data.userId ?? null,
      timestamp: new Date(),
    };

    // Always store in memory so reads work regardless of backend
    inMemoryStore.push(record);

    try {
      await prisma.rateLimitMetric.create({
        data: {
          endpoint: data.endpoint,
          key: data.key,
          ip: data.ip,
          userId: data.userId,
          timestamp: record.timestamp,
        },
      });
    } catch (error) {
      logger.warn('Prisma unavailable for recording rate-limit hit, stored in memory only:', error);
    }
  }

  /**
   * Retrieves summary statistics for rate-limit hits.
   * Merges Prisma and in-memory records when both are available.
   */
  async getSummary(limit: number = 10) {
    try {
      // Fetch from Prisma (may be empty in hackathon mode)
      const dbTopEndpoints = await withPrismaFallback(
        () =>
          prisma.rateLimitMetric.groupBy({
            by: ['endpoint'],
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: limit,
          }) as any,
        [] as any,
      );

      const dbRecentEvents = await withPrismaFallback(
        () =>
          prisma.rateLimitMetric.findMany({
            orderBy: { timestamp: 'desc' },
            take: limit * 2,
          }) as any,
        [] as any,
      );

      const dbTopAbusers = await withPrismaFallback(
        () =>
          prisma.rateLimitMetric.groupBy({
            by: ['key', 'endpoint'],
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: limit,
          }) as any,
        [] as any,
      );

      // Merge in-memory records with DB records
      const allRecent = combineWithMemoryRecords(dbRecentEvents as InMemoryMetricRecord[]);

      // Build endpoint counts from all records
      const endpointCounts = new Map<string, number>();
      for (const evt of allRecent) {
        endpointCounts.set(evt.endpoint, (endpointCounts.get(evt.endpoint) ?? 0) + 1);
      }
      const mergedTopEndpoints = [...endpointCounts.entries()]
        .map(([endpoint, hits]) => ({ endpoint, hits }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, limit);

      // Build abuser counts from all records
      const abuserCounts = new Map<string, { key: string; endpoint: string; hits: number }>();
      for (const evt of allRecent) {
        const groupKey = `${evt.key}::${evt.endpoint}`;
        const existing = abuserCounts.get(groupKey);
        if (existing) {
          existing.hits += 1;
        } else {
          abuserCounts.set(groupKey, { key: evt.key, endpoint: evt.endpoint, hits: 1 });
        }
      }
      const mergedTopAbusers = [...abuserCounts.values()]
        .sort((a, b) => b.hits - a.hits)
        .slice(0, limit);

      // Also include DB-only top endpoints/abusers that may have higher counts
      const allTopEndpoints = mergeTopEntries(
        mergedTopEndpoints,
        (dbTopEndpoints as any[]).map((e: any) => ({ endpoint: e.endpoint as string, hits: e._count.id as number })),
        limit,
      );

      const allTopAbusers = mergeTopAbusers(
        mergedTopAbusers,
        (dbTopAbusers as any[]).map((a: any) => ({ key: a.key as string, endpoint: a.endpoint as string, hits: a._count.id as number })),
        limit,
      );

      const suspiciousActivity = await this.getSuspiciousActivity(limit);

      return {
        topEndpoints: allTopEndpoints,
        topAbusers: allTopAbusers,
        recentEvents: allRecent
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, limit * 2),
        suspiciousActivity,
      };
    } catch (error) {
      logger.error('Failed to get rate-limit summary:', error);
      throw error;
    }
  }

  /**
   * Operator-facing view of auth, prediction, and chat rate-limit abuse patterns.
   */
  async getSuspiciousActivity(limit: number = 10): Promise<{
    lookbackHours: number;
    hitThreshold: number;
    byCategory: CategoryActivitySummary[];
    flaggedActors: SuspiciousActor[];
  }> {
    const since = new Date();
    since.setHours(since.getHours() - SUSPICIOUS_LOOKBACK_HOURS);

    // Fetch from Prisma (empty array when unavailable)
    const dbHits = await withPrismaFallback(
      () =>
        prisma.rateLimitMetric.findMany({
          where: { timestamp: { gte: since } },
          orderBy: { timestamp: 'desc' },
        }) as any,
      [] as any,
    );

    // Combine with in-memory hits within the lookback window
    const allHits = combineWithMemoryRecords(dbHits as InMemoryMetricRecord[]).filter(
      (r) => r.timestamp >= since,
    );

    const monitored = allHits.filter((hit) =>
      OPERATOR_MONITORED_CATEGORIES.includes(getRateLimitCategory(hit.endpoint)),
    );

    const byCategory = this.buildCategorySummaries(monitored, limit);
    const flaggedActors = this.buildFlaggedActors(monitored, limit);

    return {
      lookbackHours: SUSPICIOUS_LOOKBACK_HOURS,
      hitThreshold: SUSPICIOUS_HIT_THRESHOLD,
      byCategory,
      flaggedActors,
    };
  }

  private buildCategorySummaries(
    hits: Array<{
      endpoint: string;
      key: string;
    }>,
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

  private buildFlaggedActors(
    hits: Array<{
      endpoint: string;
      key: string;
      userId: string | null;
      ip: string | null;
      timestamp: Date;
    }>,
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

  /**
   * Clears old metrics (optional, for maintenance).
   * Clears both Prisma records (when available) and in-memory records.
   */
  async clearOldMetrics(days: number = 7): Promise<number> {
    const date = new Date();
    date.setDate(date.getDate() - days);

    let deletedCount = 0;

    // Clear from Prisma if available
    try {
      const result = await prisma.rateLimitMetric.deleteMany({
        where: {
          timestamp: {
            lt: date,
          },
        },
      });
      deletedCount += result.count;
    } catch (error) {
      logger.warn('Prisma unavailable for clearing rate-limit metrics:', error);
    }

    // Clear from in-memory store
    const beforeLength = inMemoryStore.length;
    for (let i = inMemoryStore.length - 1; i >= 0; i--) {
      if (inMemoryStore[i].timestamp < date) {
        inMemoryStore.splice(i, 1);
      }
    }
    deletedCount += beforeLength - inMemoryStore.length;

    return deletedCount;
  }

  /** Reset in-memory store (for tests). */
  resetInMemoryStore(): void {
    inMemoryStore.length = 0;
  }
}

// Helper: merge two sorted endpoint-count arrays, deduplicating by endpoint
function mergeTopEntries(
  a: Array<{ endpoint: string; hits: number }>,
  b: Array<{ endpoint: string; hits: number }>,
  limit: number,
): Array<{ endpoint: string; hits: number }> {
  const map = new Map<string, number>();
  for (const entry of a) {
    map.set(entry.endpoint, (map.get(entry.endpoint) ?? 0) + entry.hits);
  }
  for (const entry of b) {
    map.set(entry.endpoint, (map.get(entry.endpoint) ?? 0) + entry.hits);
  }
  return [...map.entries()]
    .map(([endpoint, hits]) => ({ endpoint, hits }))
    .sort((x, y) => y.hits - x.hits)
    .slice(0, limit);
}

function mergeTopAbusers(
  a: Array<{ key: string; endpoint: string; hits: number }>,
  b: Array<{ key: string; endpoint: string; hits: number }>,
  limit: number,
): Array<{ key: string; endpoint: string; hits: number }> {
  const map = new Map<string, { key: string; endpoint: string; hits: number }>();
  for (const entry of a) {
    const k = `${entry.key}::${entry.endpoint}`;
    const existing = map.get(k);
    if (existing) {
      existing.hits += entry.hits;
    } else {
      map.set(k, { ...entry });
    }
  }
  for (const entry of b) {
    const k = `${entry.key}::${entry.endpoint}`;
    const existing = map.get(k);
    if (existing) {
      existing.hits += entry.hits;
    } else {
      map.set(k, { ...entry });
    }
  }
  return [...map.values()]
    .sort((x, y) => y.hits - x.hits)
    .slice(0, limit);
}

export const rateLimitMetricsService = new RateLimitMetricsService();
