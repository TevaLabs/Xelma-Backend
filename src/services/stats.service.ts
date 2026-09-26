import { prisma } from "../lib/prisma";
import { MOCK_PLATFORM_STATS } from "../data/mockData";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlatformStats {
    totalRounds: number;
    totalUsers: number;
    totalBets: number;
    /** true = mock constants were served (DATA_MODE=mock or DB unreachable); false = live DB counts */
    isFallback: boolean;
    cachedAt: string; // ISO-8601 timestamp
}

// ---------------------------------------------------------------------------
// In-process cache (replaces a Redis dep for a 30–60 s TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000; // 30 seconds

let cachedStats: PlatformStats | null = null;
let cacheExpiresAt = 0;

function getCached(): PlatformStats | null {
    if (cachedStats && Date.now() < cacheExpiresAt) {
        return cachedStats;
    }
    return null;
}

function setCache(stats: PlatformStats): void {
    cachedStats = stats;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Returns aggregated platform statistics.
 *
 * Behaviour depends on DATA_MODE and database state:
 *   DATA_MODE=mock            → returns MOCK_PLATFORM_STATS with isFallback=true
 *   DATA_MODE=live (or unset) → queries the database:
 *     • DB has data           → returns live counts with isFallback=false
 *     • DB empty              → returns zero counts with isFallback=false
 *     • DB unreachable        → returns MOCK_PLATFORM_STATS with isFallback=true
 *
 * An empty production database returns legitimate zeros (isFallback=false)
 * so dashboards can distinguish "no data yet" from "reading mock constants".
 */
export async function getPlatformStats(): Promise<PlatformStats> {
    // 1. Return cached value if still fresh
    const hit = getCached();
    if (hit) return hit;

    // 2. In mock mode, skip the DB entirely and return seed constants
    if (process.env.DATA_MODE === "mock") {
        const stats: PlatformStats = {
            ...MOCK_PLATFORM_STATS,
            isFallback: true,
            cachedAt: new Date().toISOString(),
        };
        setCache(stats);
        return stats;
    }

    // 3. Query DB (live mode)
    let totalRounds = 0;
    let totalUsers = 0;
    let totalBets = 0;
    let dbAvailable = true;

    try {
        [totalRounds, totalUsers, totalBets] = await Promise.all([
            prisma.round.count(),
            prisma.user.count(),
            prisma.prediction.count({
                where: {
                    chainStatus: { in: ['CONFIRMED', 'NOT_REQUIRED'] },
                },
            }),
        ]);
    } catch (err) {
        dbAvailable = false;
        logger.error("[stats.service] DB query failed, using mock fallback:", {
          error: err instanceof Error ? err.message : String(err),
        });
    }

    // 4. DB unreachable → fall back to mock constants (with isFallback=true)
    if (!dbAvailable) {
        const stats: PlatformStats = {
            ...MOCK_PLATFORM_STATS,
            isFallback: true,
            cachedAt: new Date().toISOString(),
        };
        setCache(stats);
        return stats;
    }

    // 5. DB responded — return live (possibly zero) counts with isFallback=false
    const stats: PlatformStats = {
        totalRounds,
        totalUsers,
        totalBets,
        isFallback: false,
        cachedAt: new Date().toISOString(),
    };
    setCache(stats);
    return stats;
}

/**
 * Manually invalidate the stats cache.
 * Call this after any significant write (e.g. round resolution, new user) if
 * you want the next GET /api/stats to reflect the change immediately rather
 * than waiting for TTL expiry.
 */
export function invalidateStatsCache(): void {
    cachedStats = null;
    cacheExpiresAt = 0;
}