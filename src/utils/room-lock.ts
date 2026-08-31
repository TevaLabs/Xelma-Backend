/**
 * Redis distributed lock for multiplayer room mutations (Issue #555).
 *
 * Serializes addRoom / removeRoom calls per user across multiple API
 * instances so concurrent join/leave events cannot produce lost updates.
 *
 * When Redis is unavailable (single-instance or Redis-down), the lock
 * is silently bypassed and the callback executes directly — this keeps
 * single-instance deployments and degraded-Redis scenarios fully functional.
 *
 * The lock uses the SET NX PX pattern (set-if-not-exists with TTL) and a
 * Lua-based owner-check on release so stale locks auto-expire even if the
 * holding process crashes.
 */
import { getRedisClient } from '../lib/redis';
import logger from './logger';

/** Key prefix for room-mutation locks in Redis. */
const LOCK_PREFIX = 'xelma:room-lock';

/** How long (ms) a lock is held before it auto-expires (safety net). */
export const LOCK_TTL_MS = 5_000;

/** Delay (ms) between acquisition retries. */
const RETRY_DELAY_MS = 50;

/** Maximum number of acquisition attempts before falling back. */
const MAX_RETRIES = 10;

/**
 * Execute `fn` while holding a per-user Redis lock that prevents
 * concurrent room mutations for the same user across instances.
 *
 * @param userId  The user whose room list is being mutated.
 * @param fn      The mutation callback to execute under the lock.
 * @returns       The return value of `fn`.
 */
export async function withRoomLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  if (!redis) {
    // No Redis — single instance or Redis unavailable. Execute directly.
    return fn();
  }

  const lockKey = `${LOCK_PREFIX}:${userId}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Retry acquisition loop
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const acquired = await acquireLock(redis, lockKey, lockValue);
    if (acquired) {
      try {
        return await fn();
      } finally {
        await releaseLock(redis, lockKey, lockValue);
      }
    }
    await sleep(RETRY_DELAY_MS);
  }

  // Fallback: execute without the lock rather than failing.
  // In practice this path is hit very rarely (Redis latency spike).
  logger.warn(
    `[room-lock] Could not acquire lock for user ${userId} after ${MAX_RETRIES} attempts; executing without lock`,
  );
  return fn();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function acquireLock(
  redis: any,
  lockKey: string,
  lockValue: string,
): Promise<boolean> {
  try {
    const result = await redis.set(lockKey, lockValue, {
      NX: true,
      PX: LOCK_TTL_MS,
    });
    return result === 'OK';
  } catch (error) {
    logger.warn(
      `[room-lock] Failed to acquire lock ${lockKey}: ${(error as Error).message}`,
    );
    return false;
  }
}

async function releaseLock(
  redis: any,
  lockKey: string,
  lockValue: string,
): Promise<void> {
  try {
    // Lua script: only delete the key if we still own it (value matches).
    // This prevents releasing someone else's lock after our TTL expired.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, {
      keys: [lockKey],
      arguments: [lockValue],
    });
  } catch (error) {
    // Best-effort: if release fails, the TTL will auto-expire the lock.
    logger.warn(
      `[room-lock] Failed to release lock ${lockKey}: ${(error as Error).message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
