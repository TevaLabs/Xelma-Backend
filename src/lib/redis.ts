import { createClient } from "redis";
import logger from "../utils/logger";

type CacheMetrics = {
  enabled: boolean;
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  bypasses: number;
  errors: number;
};

/**
 * A single member returned from a sorted-set range query.
 * `score` is the raw Redis score (totalEarnings as a float).
 */
export type ZSetMember = {
  value: string;
  score: number;
};

const metrics: CacheMetrics = {
  enabled: false,
  hits: 0,
  misses: 0,
  sets: 0,
  invalidations: 0,
  bypasses: 0,
  errors: 0,
};

const redisCacheDebug = process.env.REDIS_CACHE_DEBUG === "true";

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let clientConnecting: Promise<RedisClient | null> | null = null;
let lastRedisFailureAtMs = 0;

function getRedisUrl(): string | null {
  const url = process.env.REDIS_URL;
  return url && url.trim().length > 0 ? url.trim() : null;
}

function getRedisCacheEnabled(): boolean {
  // Enabled by default when REDIS_URL is present. Explicit "false" disables.
  const enabledEnv = process.env.REDIS_CACHE_ENABLED;
  if (enabledEnv && enabledEnv.toLowerCase() === "false") return false;
  return Boolean(getRedisUrl());
}

function getRedisCachePrefix(): string {
  return process.env.REDIS_CACHE_PREFIX?.trim() || "xelma:cache";
}

async function ensureClient(): Promise<RedisClient | null> {
  const shouldEnable = getRedisCacheEnabled();
  const redisUrl = getRedisUrl();

  if (!shouldEnable || !redisUrl) {
    metrics.enabled = false;
    return null;
  }

  const cooldownMs = parseInt(
    process.env.REDIS_FAIL_COOLDOWN_MS || "10000",
    10,
  );
  if (lastRedisFailureAtMs > 0 && Date.now() - lastRedisFailureAtMs < cooldownMs) {
    metrics.enabled = false;
    metrics.bypasses += 1;
    return null;
  }

  if (client) return client;
  if (clientConnecting) return clientConnecting;

  metrics.enabled = true;

  clientConnecting = (async () => {
    try {
      const nextClient = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || "2000", 10),
          reconnectStrategy: () => {
            // If Redis is down, fail fast and switch to bypass mode.
            return new Error("Redis unavailable");
          },
        },
      });

      nextClient.on("error", (err) => {
        logger.warn("Redis client error", {
          message: err instanceof Error ? err.message : String(err),
        });
      });

      await nextClient.connect();
      // Force a connection check early.
      await nextClient.ping();

      client = nextClient;
      lastRedisFailureAtMs = 0;
      return client;
    } catch (error) {
      metrics.enabled = false;
      metrics.errors += 1;
      lastRedisFailureAtMs = Date.now();
      logger.warn("Redis unavailable, bypassing cache", {
        error: error instanceof Error ? error.message : String(error),
      });
      client = null;
      return null;
    } finally {
      clientConnecting = null;
    }
  })();

  return clientConnecting;
}

function namespaceVersionKey(namespace: string): string {
  return `${getRedisCachePrefix()}:ns:${namespace}:version`;
}

async function getNamespaceVersion(namespace: string): Promise<number> {
  const redisClient = await ensureClient();
  if (!redisClient) return 0;

  try {
    const raw = await redisClient.get(namespaceVersionKey(namespace));
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to read namespace version; bypassing cache", {
      namespace,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function makeNamespacedKey(namespace: string, rawKey: string): Promise<string> {
  const version = await getNamespaceVersion(namespace);
  // Final key includes version to make invalidation O(1) (INCR a version counter).
  return `${getRedisCachePrefix()}:${namespace}:v${version}:${rawKey}`;
}

export function getCacheMetrics(): CacheMetrics {
  return { ...metrics };
}

export function isRedisCacheEnabled(): boolean {
  return getRedisCacheEnabled();
}

export async function invalidateNamespace(namespace: string): Promise<void> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return;
  }

  try {
    await redisClient.incr(namespaceVersionKey(namespace));
    metrics.invalidations += 1;
    if (redisCacheDebug) {
      logger.info("Redis cache namespace invalidated", { namespace });
    }
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to invalidate cache namespace", {
      namespace,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getJsonFromCache<T>(namespace: string, rawKey: string): Promise<T | null> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return null;
  }

  const cacheKey = await makeNamespacedKey(namespace, rawKey);
  try {
    const raw = await redisClient.get(cacheKey);
    if (!raw) {
      metrics.misses += 1;
      if (redisCacheDebug) {
        logger.info("Redis cache miss", { namespace, rawKey });
      }
      return null;
    }

    metrics.hits += 1;
    if (redisCacheDebug) {
      logger.info("Redis cache hit", { namespace, rawKey });
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to read cache entry; bypassing cache", {
      namespace,
      rawKey,
      error: error instanceof Error ? error.message : String(error),
    });
    metrics.misses += 1;
    return null;
  }
}

export async function setJsonToCache<T>(
  namespace: string,
  rawKey: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return;
  }

  const cacheKey = await makeNamespacedKey(namespace, rawKey);
  const safeTtlSeconds = Number.isFinite(ttlSeconds) ? Math.max(1, Math.floor(ttlSeconds)) : 60;

  try {
    await redisClient.set(cacheKey, JSON.stringify(value), { EX: safeTtlSeconds });
    metrics.sets += 1;
    if (redisCacheDebug) {
      logger.info("Redis cache set", { namespace, rawKey, ttlSeconds: safeTtlSeconds });
    }
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to write cache entry; bypassing cache", {
      namespace,
      rawKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorted-set helpers for the materialized leaderboard
//
// The leaderboard sorted set stores every user's totalEarnings as the Redis
// score so rank queries become O(log N) instead of a full-table COUNT(*).
//
// Key format: `${REDIS_CACHE_PREFIX}:leaderboard:zset`
// Score:      totalEarnings (float, higher = better rank)
// Member:     userId (string)
//
// The set is NOT versioned (unlike the JSON cache) because it is the
// authoritative materialized view — invalidation removes the key entirely
// and the service rebuilds it lazily on the next read.
// ─────────────────────────────────────────────────────────────────────────────

function leaderboardZSetKey(): string {
  return `${getRedisCachePrefix()}:leaderboard:zset`;
}

/**
 * Add or update a single member's score in the leaderboard sorted set.
 * Safe to call after every `userStats` upsert.
 */
export async function zsetAdd(userId: string, score: number): Promise<void> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return;
  }

  try {
    await redisClient.zAdd(leaderboardZSetKey(), { score, value: userId });
    if (redisCacheDebug) {
      logger.info("Leaderboard zset updated", { userId, score });
    }
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to update leaderboard zset", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remove a member from the leaderboard sorted set.
 * Called when a user's stats row is deleted (rare, but safe to handle).
 */
export async function zsetRemove(userId: string): Promise<void> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return;
  }

  try {
    await redisClient.zRem(leaderboardZSetKey(), userId);
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to remove member from leaderboard zset", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Return the total number of members in the leaderboard sorted set.
 * Returns `null` when Redis is unavailable (caller falls back to DB COUNT).
 */
export async function zsetCard(): Promise<number | null> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return null;
  }

  try {
    return await redisClient.zCard(leaderboardZSetKey());
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to read leaderboard zset cardinality", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Return a page of leaderboard members ordered by score descending.
 *
 * @param offset  0-based start index (inclusive)
 * @param limit   Number of members to return
 * @returns Array of `{ value: userId, score: totalEarnings }`, or `null` on
 *          Redis unavailability so the caller can fall back to a DB query.
 */
export async function zsetRangeWithScores(
  offset: number,
  limit: number,
): Promise<ZSetMember[] | null> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return null;
  }

  try {
    // ZRANGE … REV BYSCORE returns highest scores first.
    const members = await redisClient.zRangeWithScores(
      leaderboardZSetKey(),
      offset,
      offset + limit - 1,
      { REV: true },
    );
    metrics.hits += 1;
    return members;
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to read leaderboard zset range", {
      offset,
      limit,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Return the 0-based rank of a user in the leaderboard (highest score = rank 0).
 * Returns `null` when Redis is unavailable or the member is not in the set.
 */
export async function zsetRank(userId: string): Promise<number | null> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return null;
  }

  try {
    // ZREVRANK returns 0 for the highest-scoring member.
    const rank = await redisClient.zRevRank(leaderboardZSetKey(), userId);
    return rank ?? null;
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to read leaderboard zset rank", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Delete the entire leaderboard sorted set so it is rebuilt on the next read.
 * Called by `invalidateNamespace("leaderboard")` sites to keep the ZSET in
 * sync with the DB after a round resolves or a prediction is submitted.
 */
export async function invalidateLeaderboardSortedSet(): Promise<void> {
  const redisClient = await ensureClient();
  if (!redisClient) {
    metrics.bypasses += 1;
    return;
  }

  try {
    await redisClient.del(leaderboardZSetKey());
    metrics.invalidations += 1;
    if (redisCacheDebug) {
      logger.info("Leaderboard sorted set invalidated");
    }
  } catch (error) {
    metrics.errors += 1;
    logger.warn("Failed to invalidate leaderboard sorted set", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

