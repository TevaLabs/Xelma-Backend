import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import {
  getRateLimitCategory,
  OPERATOR_MONITORED_CATEGORIES,
  RateLimitCategory,
} from '../security/rate-limit-endpoints';

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

export class RateLimitMetricsService {
  /**
   * Records a rate-limit hit in the database
   */
  async recordHit(data: {
    endpoint: string;
    key: string;
    ip?: string;
    userId?: string;
  }): Promise<void> {
    try {
      await prisma.rateLimitMetric.create({
        data: {
          endpoint: data.endpoint,
          key: data.key,
          ip: data.ip,
          userId: data.userId,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      logger.error('Failed to record rate-limit hit:', error);
    }
  }

  /**
   * Retrieves summary statistics for rate-limit hits
   */
  async getSummary(limit: number = 10) {
    try {
      const topEndpoints = await prisma.rateLimitMetric.groupBy({
        by: ['endpoint'],
        _count: {
          id: true,
        },
        orderBy: {
          _count: {
            id: 'desc',
          },
        },
        take: limit,
      });

      const recentEvents = await prisma.rateLimitMetric.findMany({
        orderBy: {
          timestamp: 'desc',
        },
        take: limit * 2,
      });

      const topAbusers = await prisma.rateLimitMetric.groupBy({
        by: ['key', 'endpoint'],
        _count: {
          id: true,
        },
        orderBy: {
          _count: {
            id: 'desc',
          },
        },
        take: limit,
      });

      const suspiciousActivity = await this.getSuspiciousActivity(limit);

      return {
        topEndpoints: topEndpoints.map(e => ({
          endpoint: e.endpoint,
          hits: e._count.id,
        })),
        topAbusers: topAbusers.map(a => ({
          key: a.key,
          endpoint: a.endpoint,
          hits: a._count.id,
        })),
        recentEvents,
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

    const recentHits = await prisma.rateLimitMetric.findMany({
      where: { timestamp: { gte: since } },
      orderBy: { timestamp: 'desc' },
    });

    const monitored = recentHits.filter((hit) =>
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
   * Clears old metrics (optional, for maintenance)
   */
  async clearOldMetrics(days: number = 7): Promise<number> {
    const date = new Date();
    date.setDate(date.getDate() - days);

    try {
      const result = await prisma.rateLimitMetric.deleteMany({
        where: {
          timestamp: {
            lt: date,
          },
        },
      });
      return result.count;
    } catch (error) {
      logger.error('Failed to clear old rate-limit metrics:', error);
      return 0;
    }
  }
}

export const rateLimitMetricsService = new RateLimitMetricsService();
