import { PrismaClient } from "@prisma/client";
import { MOCK_PLATFORM_STATS } from "../data/mockData";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlatformStats {
    totalRounds: number;
    totalUsers: number;
    totalBets: number;
    /** true = numbers came from the live DB; false = mock fallback was used */
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
 * Queries the database for live platform stats.
 * Falls back to MOCK_PLATFORM_STATS when the data store is empty or
 * all counts come back as zero (e.g. a freshly seeded dev environment).
 *
 * Fallback mode is documented via `isFallback: true` in the response.
 */
export async function getPlatformStats(): Promise<PlatformStats> {
    // 1. Return cached value if still fresh
    const hit = getCached();
    if (hit) return hit;

    // 2. Query DB
    let totalRounds = 0;
    let totalUsers = 0;
    let totalBets = 0;
    let dbAvailable = true;

    try {
        [totalRounds, totalUsers, totalBets] = await Promise.all([
            prisma.round.count(),
            prisma.user.count(),
            prisma.prediction.count(),
        ]);
    } catch (err) {
        // DB unreachable (connection error, migration pending, etc.)
        dbAvailable = false;
        console.error("[stats.service] DB query failed, using mock fallback:", err);
    }

    // 3. Decide whether to use live or mock data
    const dataIsEmpty = totalRounds === 0 && totalUsers === 0 && totalBets === 0;
    const useFallback = !dbAvailable || dataIsEmpty;

    const stats: PlatformStats = useFallback
        ? {
            ...MOCK_PLATFORM_STATS,
            isFallback: true,
            cachedAt: new Date().toISOString(),
        }
        : {
            totalRounds,
            totalUsers,
            totalBets,
            isFallback: false,
            cachedAt: new Date().toISOString(),
        };

    // 4. Cache and return
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