/**
 * Per-user lock for multiplayer room membership (Issues #555, #669).
 *
 * Serializes the room-membership protocol (DB write + Socket.IO adapter
 * join/leave, see multiplayer-session.service.ts) per user, so a join and a
 * leave for the same user cannot interleave and leave the adapter disagreeing
 * with the DB.
 *
 * Two layers:
 *
 *   1. An in-process queue per user. Always on. This is the only serialization
 *      a single instance without Redis needs.
 *   2. A Redis lock (SET NX PX + Lua owner-check release) shared by all
 *      instances when Redis is configured and reachable. Stale locks
 *      auto-expire after LOCK_TTL_MS even if the holder crashes.
 *
 * When Redis is unavailable, or the lock cannot be acquired within
 * LOCK_TTL_MS, the callback still runs (degraded, cross-instance races become
 * possible). Reconnect reconciliation in socket.ts re-derives every socket's
 * rooms from the DB, so any drift from that path heals on the next connect.
 */
import type { RedisClientType } from 'redis';
import { getConnectedRedisClient } from '../lib/redis';
import logger from './logger';

/** Key prefix for room-mutation locks in Redis. */
const LOCK_PREFIX = 'xelma:room-lock';

/** How long (ms) a lock is held before it auto-expires (safety net). */
export const LOCK_TTL_MS = 5_000;

/** Delay (ms) between acquisition retries. */
export const RETRY_DELAY_MS = 50;

/**
 * Maximum number of acquisition attempts before falling back. Waiting for a
 * full TTL means a waiter either gets the lock or the holder's lock expired.
 */
export const MAX_LOCK_ATTEMPTS = Math.ceil(LOCK_TTL_MS / RETRY_DELAY_MS);

/** Tail of the in-process queue for each user. Never rejects. */
const localTails = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding the per-user room lock.
 *
 * @param userId  The user whose room membership is being mutated.
 * @param fn      The mutation callback to execute under the lock.
 * @returns       The return value of `fn`.
 */
export async function withRoomLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLocalQueue(userId, () => withRedisLock(userId, fn));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function withLocalQueue<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = localTails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localTails.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (localTails.get(key) === tail) localTails.delete(key);
  }
}

async function withRedisLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  let redis: RedisClientType | null = null;
  try {
    redis = await getConnectedRedisClient();
  } catch (error) {
    logger.warn(
      `[room-lock] Redis client unavailable for user ${userId}: ${(error as Error).message}`,
    );
  }
  if (!redis) {
    // No Redis: single instance, or Redis down. The in-process queue above
    // still serializes this instance.
    return fn();
  }

  const lockKey = `${LOCK_PREFIX}:${userId}`;
  const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
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

  // Fallback: execute without the lock rather than failing the request.
  logger.warn(
    `[room-lock] Could not acquire lock for user ${userId} after ${MAX_LOCK_ATTEMPTS} attempts; executing without lock`,
  );
  return fn();
}

async function acquireLock(
  redis: RedisClientType,
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
  redis: RedisClientType,
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
