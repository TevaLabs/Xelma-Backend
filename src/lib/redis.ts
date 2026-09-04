import { createClient, type RedisClientType } from "redis";
import { withTimeout } from "../utils/timeout-wrapper";
import logger from "../utils/logger";
import type { Options, Store, IncrementResponse } from "express-rate-limit";

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

let client: RedisClientType | null = null;
let clientConnecting: Promise<RedisClientType | null> | null = null;
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

/**
 * Resolves the shared Redis client, connecting on first use.
 *
 * @param respectCacheFlag When true (cache paths), a Redis URL present but
 *   `REDIS_CACHE_ENABLED=false` disables the client. When false (fail-closed
 *   paths such as distributed idempotency locks), the client is only skipped
 *   when no Redis URL is configured or Redis is unreachable.
 */
async function ensureClient(respectCacheFlag = true): Promise<RedisClientType | null> {
  const shouldEnable = respectCacheFlag ? getRedisCacheEnabled() : true;
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

export function getRedisClient(): RedisClientType | null {
  return client;
}

/**
 * Closes the shared Redis client and resets connection state. Used by tests
 * that connect to a real Redis so Jest workers can exit cleanly.
 */
export async function closeRedisClient(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch (error) {
      logger.warn("Failed to close Redis client cleanly", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    client = null;
  }
  clientConnecting = null;
  lastRedisFailureAtMs = 0;
}

/**
 * Ensures the shared Redis client is connected and returns it.
 *
 * This is the fail-closed entry point used by money-path distributed locks
 * (Issue #493). Unlike the cache helpers, which intentionally bypass when
 * Redis is unavailable, callers of this function MUST treat a `null` return
 * as "Redis is unreachable" and reject the request rather than proceeding
 * without the lock. `REDIS_CACHE_ENABLED=false` does not disable this path;
 * only the absence of a configured `REDIS_URL` or an unreachable Redis does.
 *
 * @returns The connected shared client, or `null` when Redis is not
 *          configured or cannot be reached.
 */
export async function getConnectedRedisClient(): Promise<RedisClientType | null> {
  return ensureClient(false);
}

export async function checkRedisHealth(
  timeoutMs: number,
): Promise<{ status: string; durationMs: number; error?: string }> {
  if (!isRedisCacheEnabled()) {
    return { status: "bypassed", durationMs: 0 };
  }

  const start = Date.now();
  try {
    const redisClient = await ensureClient();
    if (!redisClient) {
      return { status: "unavailable", durationMs: Date.now() - start };
    }

    const result = await withTimeout(
      () => redisClient.ping(),
      {
        timeoutMs: Math.min(timeoutMs, 1000),
        operationName: "health-redis-ping",
        retries: 1,
      },
    );

    if (!result.success) {
      return {
        status: "degraded",
        durationMs: Date.now() - start,
        error: result.error?.message,
      };
    }

    return { status: "healthy", durationMs: Date.now() - start };
  } catch (err) {
    return {
      status: "degraded",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis-backed express-rate-limit store (Issue #520)
//
// Backs every rate limiter with Redis so throttles hold across replicas:
// each limiter writes its counter to a shared key (`<prefix>:<hashed key>`)
// using a fixed window anchored at the first request of the window, so all
// instances see the same counts.
//
// Each limiter MUST get its own RedisRateLimitStore instance with a distinct
// `prefix` (the middleware does this) — two limiters sharing a prefix would
// share counters and double-throttle a single request that passes through
// both.
//
// Outage policy (when Redis is configured but unreachable):
//   - failOpen = true  (default): requests fall back to a per-process
//     in-memory window. The API stays up and requests are still throttled per
//     instance, but a multi-replica deployment briefly degrades to per-node
//     counting until Redis recovers. A warning is logged (throttled) and the
//     onOutage metric callback fires on every fallback hit.
//   - failOpen = false: increments throw and express-rate-limit rejects the
//     request (HTTP 500), making a Redis outage loud. Choose this only when
//     shared throttling is a hard security requirement.
//
// When REDIS_URL is not configured at all the middleware never constructs
// this store and express-rate-limit keeps its in-process MemoryStore, so
// single-node deployments are unchanged (see isRedisRateLimitConfigured).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lua script used by {@link RedisRateLimitStore.increment}.
 *
 * KEYS[1] = full counter key
 * ARGV[1] = current unix time (ms)
 * ARGV[2] = window length (ms)
 *
 * Stores `count` and `reset` (absolute unix ms when the window ends) in a
 * hash so the increment and the window reset are atomic. Returns
 * `[hits, reset]`. The TTL is refreshed on every hit so an active client's
 * counter survives to the end of its window.
 */
const RATE_LIMIT_INCREMENT_SCRIPT = `
local reset = redis.call('HGET', KEYS[1], 'reset')
if reset == false or tonumber(reset) <= tonumber(ARGV[1]) then
  redis.call('HSET', KEYS[1], 'count', 0)
  redis.call('HSET', KEYS[1], 'reset', tonumber(ARGV[1]) + tonumber(ARGV[2]))
end
local hits = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return { hits, redis.call('HGET', KEYS[1], 'reset') }
`;

/** Lua script that decrements a counter without going below zero. */
const RATE_LIMIT_DECREMENT_SCRIPT = `
local hits = redis.call('HINCRBY', KEYS[1], 'count', -1)
if hits < 0 then
  redis.call('HSET', KEYS[1], 'count', 0)
  return 0
end
return hits
`;

export type RedisRateLimitStoreOptions = {
  /**
   * Redis key prefix for this limiter. MUST be unique per limiter instance so
   * stacked limiters (e.g. api + write + bet) never share counters.
   */
  prefix: string;
  /**
   * Outage policy — see the module docs above. Defaults to `true` (fall back
   * to an in-process window instead of failing the request).
   */
  failOpen?: boolean;
  /**
   * Resolves the shared Redis client. Defaults to {@link getConnectedRedisClient}
   * so the limiter reuses the app's single connection; tests inject stubs or
   * a provider that always resolves `null` to simulate an outage.
   */
  getClient?: () => Promise<RedisClientType | null>;
  /** Called once per request that had to use the in-process fallback. */
  onOutage?: () => void;
};

/**
 * express-rate-limit `Store` backed by the shared Redis client (Issue #520).
 * See the module-level comment for the outage policy.
 */
export class RedisRateLimitStore implements Store {
  /** Counts live in Redis, shared by every replica — never instance-local. */
  readonly localKeys = false;

  prefix: string;

  private readonly failOpen: boolean;
  private readonly getClient: () => Promise<RedisClientType | null>;
  private readonly onOutage: (() => void) | undefined;

  /** Fixed-window length captured from express-rate-limit's options.init(). */
  private windowMs = 60_000;

  /** Per-process fallback windows used while Redis is unreachable. */
  private readonly localWindows = new Map<string, { count: number; resetAtMs: number }>();

  /** Guards the throttled outage warning (at most one per 30 s per limiter). */
  private lastOutageWarnAtMs = 0;

  constructor(options: RedisRateLimitStoreOptions) {
    this.prefix = options.prefix;
    this.failOpen = options.failOpen ?? true;
    this.getClient = options.getClient ?? (() => getConnectedRedisClient());
    this.onOutage = options.onOutage;
  }

  /** express-rate-limit calls this once at limiter creation. */
  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const storeKey = this.keyFor(key);
    const client = await this.getClient();
    if (client) {
      try {
        const now = Date.now();
        const reply = (await client.sendCommand([
          "EVAL",
          RATE_LIMIT_INCREMENT_SCRIPT,
          "1",
          storeKey,
          String(now),
          String(this.windowMs),
        ])) as [number | string, number | string];
        const totalHits = Number(reply[0]);
        const resetAtMs = Number(reply[1]);
        if (!Number.isFinite(totalHits) || !Number.isFinite(resetAtMs)) {
          throw new Error("Rate-limit store returned an unexpected reply from Redis");
        }
        return { totalHits, resetTime: new Date(resetAtMs) };
      } catch (error) {
        return this.handleOutage(storeKey, error);
      }
    }
    return this.handleOutage(storeKey, new Error("Redis is not configured or unreachable"));
  }

  async decrement(key: string): Promise<void> {
    const storeKey = this.keyFor(key);
    const client = await this.getClient();
    if (client) {
      try {
        await client.sendCommand(["EVAL", RATE_LIMIT_DECREMENT_SCRIPT, "1", storeKey]);
        return;
      } catch (error) {
        this.noteOutage(error);
        if (!this.failOpen) throw error;
        this.decrementLocal(storeKey);
        return;
      }
    }
    this.noteOutage(new Error("Redis is not configured or unreachable"));
    if (!this.failOpen) {
      throw new Error("Redis is not configured or unreachable");
    }
    this.decrementLocal(storeKey);
  }

  async resetKey(key: string): Promise<void> {
    const storeKey = this.keyFor(key);
    const client = await this.getClient();
    if (client) {
      try {
        await client.del(storeKey);
        return;
      } catch (error) {
        this.noteOutage(error);
        if (!this.failOpen) throw error;
        this.resetLocal(storeKey);
        return;
      }
    }
    this.noteOutage(new Error("Redis is not configured or unreachable"));
    if (!this.failOpen) {
      throw new Error("Redis is not configured or unreachable");
    }
    this.resetLocal(storeKey);
  }

  private keyFor(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Routes an increment through the outage policy: log (throttled) + metric,
   * then either serve from the in-process fallback window (fail-open) or
   * rethrow so express-rate-limit rejects the request (fail-closed).
   */
  private handleOutage(storeKey: string, cause: unknown): IncrementResponse {
    this.noteOutage(cause);
    if (!this.failOpen) {
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
    return this.incrementLocal(storeKey);
  }

  private noteOutage(error: unknown): void {
    const now = Date.now();
    if (now - this.lastOutageWarnAtMs > 30_000) {
      this.lastOutageWarnAtMs = now;
      logger.warn(
        this.failOpen
          ? "Rate-limit store unavailable; serving from per-process window until Redis recovers"
          : "Rate-limit store unavailable; rejecting request (fail-closed policy)",
        {
          prefix: this.prefix,
          failOpen: this.failOpen,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    this.onOutage?.();
  }

  private incrementLocal(storeKey: string): IncrementResponse {
    const now = Date.now();
    const entry = this.localWindows.get(storeKey);
    if (!entry || now >= entry.resetAtMs) {
      this.localWindows.set(storeKey, { count: 1, resetAtMs: now + this.windowMs });
      return { totalHits: 1, resetTime: new Date(now + this.windowMs) };
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: new Date(entry.resetAtMs) };
  }

  private decrementLocal(storeKey: string): void {
    const entry = this.localWindows.get(storeKey);
    if (entry && entry.count > 0) {
      entry.count -= 1;
    }
  }

  private resetLocal(storeKey: string): void {
    this.localWindows.delete(storeKey);
  }
}

/**
 * Whether rate limiters should use the shared Redis store.
 *
 * True whenever `REDIS_URL` is configured — independent of
 * `REDIS_CACHE_ENABLED`, because throttles are a security control and must
 * not silently degrade to per-instance counting just because the JSON cache
 * was switched off. Callers (the rate limiter middleware) keep the default
 * in-process MemoryStore when this is false.
 */
export function isRedisRateLimitConfigured(): boolean {
  return Boolean(getRedisUrl());
}

