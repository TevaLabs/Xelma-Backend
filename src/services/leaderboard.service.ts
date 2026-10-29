import { GameMode } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  getJsonFromCache,
  invalidateLeaderboardSortedSet,
  invalidateNamespace,
  setJsonToCache,
  zsetCard,
  zsetRangeWithScores,
  zsetRank,
} from "../lib/redis";
import {
  LeaderboardEntry,
  LeaderboardCursorResponse,
  LeaderboardResponse,
} from "../types/leaderboard.types";
import { toDecimal, toNumber, serializeMoney } from "../utils/decimal.util";
import { isPredictionCorrect } from "../utils/prediction-outcome.util";
import {
  buildCursorMeta,
  buildOffsetMeta,
  decodeCursor,
  trimSentinel,
} from "../utils/pagination.util";

const LEADERBOARD_CACHE_NAMESPACE = "leaderboard";
const LEADERBOARD_CACHE_TTL_SECONDS = parseInt(
  process.env.LEADERBOARD_CACHE_TTL_SECONDS || "60",
  10,
);

interface MemoryCacheEntry<T> {
  data: T;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry<any>>();

export function clearLeaderboardMemoryCache(): void {
  memoryCache.clear();
}

export function getLeaderboardMemoryCacheSize(): number {
  return memoryCache.size;
}

function isCacheEnabled(): boolean {
  const enabledEnv = process.env.REDIS_CACHE_ENABLED;
  if (enabledEnv && enabledEnv.toLowerCase() === "false") return false;
  return true;
}

function getFromMemoryCache<T>(key: string): T | null {
  if (!isCacheEnabled()) return null;
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setToMemoryCache<T>(key: string, data: T, ttlSeconds: number): void {
  if (!isCacheEnabled()) return;
  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

/**
 * Invalidate all leaderboard cache layers:
 * 1. In-memory cache keys (for leaderboard pages and cursor queries).
 * 2. Versioned Redis JSON namespace keys (`leaderboard`).
 * 3. Materialized Redis sorted set (`leaderboard:zset`).
 *
 * Call this when a round resolves or user stats are updated to prevent stale ranks.
 */
export async function invalidateLeaderboardCache(): Promise<void> {
  clearLeaderboardMemoryCache();
  try {
    const res = invalidateNamespace(LEADERBOARD_CACHE_NAMESPACE);
    if (res && typeof (res as any).catch === "function") {
      await res;
    }
  } catch {
    // Non-blocking: safe when Redis is unavailable or unconfigured
  }
  try {
    const res = invalidateLeaderboardSortedSet();
    if (res && typeof (res as any).catch === "function") {
      await res;
    }
  } catch {
    // Non-blocking: safe when Redis is unavailable or unconfigured
  }
}

/**
 * Redis cache key format (versioned namespace):
 * - Namespace: `leaderboard`
 * - Raw key: `limit=${limit}:offset=${offset}:user=${userId ?? "anon"}`
 * - Final Redis key: `${REDIS_CACHE_PREFIX}:leaderboard:v${version}:${rawKey}`
 * - TTL: `LEADERBOARD_CACHE_TTL_SECONDS` (seconds)
 *
 * Materialized sorted set:
 * - Key: `${REDIS_CACHE_PREFIX}:leaderboard:zset`
 * - Score: totalEarnings (float, higher = better rank)
 * - Member: userId
 *
 * The sorted set is the primary rank-computation path. When it is absent
 * (Redis unavailable or after invalidation) the service falls back to the
 * existing DB COUNT(*) approach so behaviour is always correct.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskWalletAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function calculateAccuracy(correct: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((correct / total) * 100 * 100) / 100; // Round to 2 decimals
}

/**
 * Build a `LeaderboardEntry` from a raw `UserStats` row (with `user` included).
 * `rank` must be supplied by the caller because it depends on the query context.
 */
function buildEntry(
  stat: {
    user: { id: string; walletAddress: string };
    totalEarnings: any;
    totalPredictions: number;
    correctPredictions: number;
    upDownWins: number;
    upDownLosses: number;
    upDownEarnings: any;
    legendsWins: number;
    legendsLosses: number;
    legendsEarnings: any;
  },
  rank: number,
): LeaderboardEntry {
  return {
    rank,
    userId: stat.user.id,
    walletAddress: maskWalletAddress(stat.user.walletAddress),
    totalEarnings: serializeMoney(stat.totalEarnings),
    totalPredictions: stat.totalPredictions,
    accuracy: calculateAccuracy(stat.correctPredictions, stat.totalPredictions),
    modeStats: {
      upDown: {
        wins: stat.upDownWins,
        losses: stat.upDownLosses,
        earnings: serializeMoney(stat.upDownEarnings),
        accuracy: calculateAccuracy(
          stat.upDownWins,
          stat.upDownWins + stat.upDownLosses,
        ),
      },
      legends: {
        wins: stat.legendsWins,
        losses: stat.legendsLosses,
        earnings: serializeMoney(stat.legendsEarnings),
        accuracy: calculateAccuracy(
          stat.legendsWins,
          stat.legendsWins + stat.legendsLosses,
        ),
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the global leaderboard page.
 *
 * Fast path (Redis available):
 *   1. Read the requested rank window from the sorted set (O(log N + M)).
 *   2. Fetch only the matching `UserStats` rows by userId (point lookups).
 *   3. Cache the assembled page in the versioned JSON cache.
 *
 * Fallback path (Redis unavailable or set empty):
 *   - Falls back to the original `findMany … orderBy totalEarnings` query.
 */
export async function getLeaderboard(
  limit: number = 100,
  offset: number = 0,
  userId?: string,
): Promise<LeaderboardResponse> {
  const rawKey = `limit=${limit}:offset=${offset}:user=${userId ?? "anon"}`;

  type LeaderboardCachePayload = Omit<LeaderboardResponse, "lastUpdated">;

  // ── 1. Try memory cache and versioned JSON cache ───────────────────────────
  const memCached = getFromMemoryCache<LeaderboardCachePayload>(rawKey);
  if (memCached) {
    return {
      ...memCached,
      lastUpdated: new Date().toISOString(),
    };
  }

  const cached = await getJsonFromCache<LeaderboardCachePayload>(
    LEADERBOARD_CACHE_NAMESPACE,
    rawKey,
  );

  if (cached) {
    setToMemoryCache(rawKey, cached, LEADERBOARD_CACHE_TTL_SECONDS);
    return {
      ...cached,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── 2. Try the materialized sorted set ────────────────────────────────────
  let leaderboard: LeaderboardEntry[] | null = null;
  let totalUsers: number | null = null;

  const zsetMembers = await zsetRangeWithScores(offset, limit);

  if (zsetMembers && zsetMembers.length > 0) {
    // Fetch full stats for the returned userIds in a single IN query.
    const userIds = zsetMembers.map((m) => m.value);

    const statsRows = await prisma.userStats.findMany({
      where: { userId: { in: userIds } },
      include: {
        user: { select: { id: true, walletAddress: true } },
      },
    });

    // Re-order rows to match the sorted-set order (ZSET is authoritative for rank).
    const statsById = new Map(statsRows.map((s) => [s.userId, s]));

    leaderboard = zsetMembers
      .map((member, index) => {
        const stat = statsById.get(member.value);
        if (!stat) return null;
        return buildEntry(stat, offset + index + 1);
      })
      .filter((e): e is LeaderboardEntry => e !== null);

    totalUsers = await zsetCard();
    if (totalUsers === null) {
      // ZSET cardinality unavailable — fall back to DB count.
      totalUsers = await prisma.userStats.count();
    }
  }

  // ── 3. DB fallback when ZSET is empty or unavailable ─────────────────────
  if (leaderboard === null) {
    const userStats = await prisma.userStats.findMany({
      take: limit,
      skip: offset,
      orderBy: { totalEarnings: "desc" },
      include: {
        user: { select: { id: true, walletAddress: true } },
      },
    });

    leaderboard = userStats.map((stat, index) =>
      buildEntry(stat, offset + index + 1),
    );

    totalUsers = await prisma.userStats.count();
  }

  // ── 4. Resolve authenticated user position ────────────────────────────────
  let userPosition: LeaderboardEntry | undefined;
  if (userId) {
    userPosition = await getUserPosition(userId);
  }

  // ── 5. Store in versioned JSON cache and in-memory cache ──────────────────
  const payload: LeaderboardCachePayload = {
    leaderboard,
    userPosition,
    totalUsers: totalUsers ?? 0,
    pagination: buildOffsetMeta(limit, offset, totalUsers ?? 0),
  };

  setToMemoryCache(rawKey, payload, LEADERBOARD_CACHE_TTL_SECONDS);

  await setJsonToCache(
    LEADERBOARD_CACHE_NAMESPACE,
    rawKey,
    payload,
    LEADERBOARD_CACHE_TTL_SECONDS,
  );

  return {
    ...payload,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Cursor encodes `{ totalEarnings, userId }` of the last entry on the
 * previous page. Using both fields handles ties in totalEarnings correctly.
 *
 * @param limit  - page size (1–500)
 * @param cursor - opaque cursor from a previous response (optional)
 * @param userId - authenticated user id for userPosition lookup (optional)
 */
export async function getLeaderboardCursor(
  limit: number = 100,
  cursor?: string,
  userId?: string,
): Promise<LeaderboardCursorResponse> {
  const rawKey = `limit=${limit}:cursor=${cursor ?? "none"}:user=${userId ?? "anon"}`;

  type LeaderboardCursorCachePayload = Omit<LeaderboardCursorResponse, "lastUpdated">;

  const memCached = getFromMemoryCache<LeaderboardCursorCachePayload>(rawKey);
  if (memCached) {
    return {
      ...memCached,
      lastUpdated: new Date().toISOString(),
    };
  }

  // Try versioned JSON cache first
  const cached = await getJsonFromCache<LeaderboardCursorCachePayload>(
    LEADERBOARD_CACHE_NAMESPACE,
    rawKey,
  );

  if (cached) {
    setToMemoryCache(rawKey, cached, LEADERBOARD_CACHE_TTL_SECONDS);
    return {
      ...cached,
      lastUpdated: new Date().toISOString(),
    };
  }

  const decoded = decodeCursor<{ totalEarnings: string; userId: string }>(cursor);

  // Fetch limit+1 rows for the sentinel trick
  const userStats = await prisma.userStats.findMany({
    take: limit + 1,
    orderBy: [{ totalEarnings: "desc" }, { userId: "asc" }],
    ...(decoded
      ? {
          cursor: { userId: decoded.userId },
          skip: 1,
        }
      : {}),
    include: {
      user: {
        select: {
          id: true,
          walletAddress: true,
        },
      },
    },
  });

  // We need the global offset of the first row on this page to compute ranks.
  // Count how many rows have higher earnings than the cursor row.
  let rankOffset = 0;
  if (decoded) {
    rankOffset = await prisma.userStats.count({
      where: {
        totalEarnings: { gt: decoded.totalEarnings },
      },
    });
  }

  const pagination = buildCursorMeta(limit, userStats, (stat) => ({
    totalEarnings: stat.totalEarnings.toString(),
    userId: stat.userId,
  }));

  const pageStats = trimSentinel(userStats, limit);

  const leaderboard: LeaderboardEntry[] = pageStats.map((stat, index) =>
    buildEntry(stat, rankOffset + index + 1)
  );

  let userPosition: LeaderboardEntry | undefined;
  if (userId) {
    userPosition = await getUserPosition(userId);
  }

  const payload: LeaderboardCursorCachePayload = {
    leaderboard,
    userPosition,
    pagination,
  };

  setToMemoryCache(rawKey, payload, LEADERBOARD_CACHE_TTL_SECONDS);

  await setJsonToCache(
    LEADERBOARD_CACHE_NAMESPACE,
    rawKey,
    payload,
    LEADERBOARD_CACHE_TTL_SECONDS,
  );

  return {
    ...payload,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Return a single user's leaderboard position.
 *
 * Fast path (Redis available):
 *   - Rank = `ZREVRANK leaderboard:zset userId` + 1  (O(log N))
 *
 * Fallback path (Redis unavailable or member absent):
 *   - Rank = `COUNT(*) WHERE totalEarnings > userEarnings` + 1
 */
export async function getUserPosition(
  userId: string,
): Promise<LeaderboardEntry | undefined> {
  const userStats = await prisma.userStats.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, walletAddress: true } },
    },
  });

  if (!userStats) return undefined;

  // ── Fast path: sorted set rank ────────────────────────────────────────────
  let rank: number;
  const zRank = await zsetRank(userId);

  if (zRank !== null) {
    // zRank is 0-based (0 = highest score), convert to 1-based.
    rank = zRank + 1;
  } else {
    // ── Fallback: DB COUNT(*) ─────────────────────────────────────────────
    rank =
      (await prisma.userStats.count({
        where: {
          totalEarnings: { gt: userStats.totalEarnings },
        },
      })) + 1;
  }

  return buildEntry(userStats, rank);
}

/**
 * Return leaderboard positions for multiple users in a single call.
 * Each lookup is independent; partial success is supported.
 */
export async function getBatchUserPositions(userIds: string[]): Promise<
  Array<{
    userId: string;
    position?: LeaderboardEntry;
    error?: string;
  }>
> {
  const results = await Promise.allSettled(
    userIds.map(async (userId) => {
      const position = await getUserPosition(userId);
      return { userId, position };
    }),
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      userId: userIds[index],
      error:
        result.reason instanceof Error
          ? result.reason.message
          : "Unknown error",
    };
  });
}

/**
 * Update user stats after a round closes and keep the materialized sorted set
 * in sync.
 *
 * All DB writes for a single user are wrapped in a transaction so the stats
 * row and the sorted-set score are always consistent. The ZSET write happens
 * after the transaction commits — a Redis failure never rolls back the DB.
 *
 * Call this when you resolve predictions for a round.
 */
export async function updateUserStatsForRound(roundId: string): Promise<void> {
  // Get the round with predictions
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: {
      predictions: {
        where: {
          chainStatus: { in: ['CONFIRMED', 'NOT_REQUIRED'] },
        },
        include: { user: true },
      },
    },
  });

  if (!round || !round.endPrice) {
    throw new Error("Round not found or not closed");
  }

  // Process each prediction inside its own transaction so a failure on one
  // user does not roll back the others.
  for (const prediction of round.predictions) {
    const isCorrect = isPredictionCorrect(prediction, round);
    const earnings = toDecimal(
      isCorrect ? toNumber(prediction.amount) : -toNumber(prediction.amount),
    );

    const isUpDown = round.mode === GameMode.UP_DOWN;
    const isLegends = round.mode === GameMode.LEGENDS;
    const earningsNum = toNumber(earnings);

    // ── Transactional DB upsert ───────────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      return tx.userStats.upsert({
        where: { userId: prediction.userId },
        create: {
          userId: prediction.userId,
          totalPredictions: 1,
          correctPredictions: isCorrect ? 1 : 0,
          totalEarnings: earningsNum,
          upDownWins: isUpDown && isCorrect ? 1 : 0,
          upDownLosses: isUpDown && !isCorrect ? 1 : 0,
          upDownEarnings: isUpDown ? earningsNum : 0,
          legendsWins: isLegends && isCorrect ? 1 : 0,
          legendsLosses: isLegends && !isCorrect ? 1 : 0,
          legendsEarnings: isLegends ? earningsNum : 0,
        },
        update: {
          totalPredictions: { increment: 1 },
          correctPredictions: { increment: isCorrect ? 1 : 0 },
          totalEarnings: { increment: earningsNum },
          upDownWins: { increment: isUpDown && isCorrect ? 1 : 0 },
          upDownLosses: { increment: isUpDown && !isCorrect ? 1 : 0 },
          upDownEarnings: { increment: isUpDown ? earningsNum : 0 },
          legendsWins: { increment: isLegends && isCorrect ? 1 : 0 },
          legendsLosses: { increment: isLegends && !isCorrect ? 1 : 0 },
          legendsEarnings: { increment: isLegends ? earningsNum : 0 },
        },
      });
    });
  }

  // All DB writes are done. Invalidate both cache layers so the next
  // leaderboard read rebuilds from the freshly updated DB rows.
  void invalidateLeaderboardCache().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

// The "was this prediction correct?" rule now lives in
// `src/utils/prediction-outcome.util.ts` so the incremental writer here and
// the full rebuild in `stats.service.ts` (Issue #877) can never disagree.

