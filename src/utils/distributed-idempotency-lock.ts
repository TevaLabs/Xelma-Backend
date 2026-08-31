import { randomUUID } from "crypto";
import logger from "./logger";
import { getConnectedRedisClient } from "../lib/redis";
import { ConflictError, ErrorCode } from "./errors";

/**
 * Fail-closed Redis distributed lock for bet-route idempotency (Issue #493).
 *
 * This module EXTENDS the Prisma-backed idempotency flow in
 * `idempotency.util.ts`; it does not replace or bypass it. The database row
 * (`prisma.idempotencyKey`) remains the source of truth for replaying the
 * final response of a completed request. The Redis lock adds a fast,
 * cross-replica mutual-exclusion barrier in front of the Prisma flow so that
 * multiple horizontally-scaled API replicas cannot both enter the DB lock /
 * bet-processing section for the same `user + endpoint + idempotencyKey`.
 *
 * ## Fail-closed policy (money path)
 *
 * Bet routes with an `Idempotency-Key` MUST hold this distributed lock before
 * processing. If Redis is not configured, unreachable, or the lock cannot be
 * acquired/verified, the request is rejected:
 *
 * - Redis outage / command failure -> {@link DistributedIdempotencyLockUnavailableError}
 *   (mapped to HTTP 503 by the route) — the bet never proceeds.
 * - Lock held by another replica past the acquisition window ->
 *   `ConflictError` (HTTP 409) — the bet never proceeds.
 *
 * There is deliberately NO fallback to Prisma-only locking on Redis failure:
 * silently proceeding without the distributed lock would reintroduce the
 * duplicate-bet race this issue fixes.
 *
 * Lock release is best-effort: if the release command fails after the request
 * completed, the TTL auto-expires the lock and the DB row still replays the
 * response, so a release failure cannot cause a double-acceptance.
 */

/** Machine-readable code for distributed-lock unavailability. */
export const DISTRIBUTED_IDEMPOTENCY_LOCK_UNAVAILABLE =
  "DISTRIBUTED_IDEMPOTENCY_LOCK_UNAVAILABLE";

/** Thrown when Redis cannot be reached or a lock command fails (fail-closed). */
export class DistributedIdempotencyLockUnavailableError extends Error {
  readonly code = DISTRIBUTED_IDEMPOTENCY_LOCK_UNAVAILABLE;

  constructor(
    message = "Distributed idempotency lock unavailable. Please retry.",
  ) {
    super(message);
    this.name = "DistributedIdempotencyLockUnavailableError";
  }
}

export interface DistributedIdempotencyLockConfig {
  /** Seconds the lock is held before Redis auto-expires it (safety net). */
  ttlSeconds?: number;
  /** Total time to keep retrying while another replica holds the lock. */
  acquireTimeoutMs?: number;
  /** Delay between acquisition attempts. */
  retryDelayMs?: number;
}

export interface DistributedIdempotencyLockHandle {
  readonly lockKey: string;
  readonly token: string;
  /** Best-effort release; the Redis TTL bounds the lock if this fails. */
  release(): Promise<void>;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_CONFIG: Required<DistributedIdempotencyLockConfig> = {
  ttlSeconds: envPositiveInt("IDEMPOTENCY_LOCK_TTL_SECONDS", 30),
  acquireTimeoutMs: envPositiveInt(
    "IDEMPOTENCY_LOCK_ACQUIRE_TIMEOUT_MS",
    10_000,
  ),
  retryDelayMs: envPositiveInt("IDEMPOTENCY_LOCK_RETRY_DELAY_MS", 100),
};

const LOCK_PREFIX = "xelma:idempotency-lock";

/** Lock key is scoped to user + endpoint + idempotency key. */
export function buildDistributedIdempotencyLockKey(
  userId: string,
  endpoint: string,
  idempotencyKey: string,
): string {
  return `${LOCK_PREFIX}:${userId}:${endpoint}:${idempotencyKey}`;
}

/**
 * Acquires the Redis distributed idempotency lock (SET NX EX), retrying while
 * another replica holds it. Fail-closed: throws when Redis is unavailable.
 *
 * @returns A handle that must be released (or allowed to expire) when the
 *          critical section completes.
 */
export async function acquireDistributedIdempotencyLock(
  userId: string,
  endpoint: string,
  idempotencyKey: string,
  config: DistributedIdempotencyLockConfig = {},
): Promise<DistributedIdempotencyLockHandle> {
  const { ttlSeconds, acquireTimeoutMs, retryDelayMs } = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  const lockKey = buildDistributedIdempotencyLockKey(
    userId,
    endpoint,
    idempotencyKey,
  );
  const token = randomUUID();

  const redis = await getConnectedRedisClient();
  if (!redis) {
    logger.error(
      "[distributed-idempotency-lock] Redis unavailable; rejecting bet request (fail-closed)",
      { userId, endpoint, idempotencyKey, lockKey },
    );
    throw new DistributedIdempotencyLockUnavailableError();
  }

  const deadline = Date.now() + acquireTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await redis.set(lockKey, token, {
        NX: true,
        EX: ttlSeconds,
      });

      if (result === "OK") {
        logger.debug("[distributed-idempotency-lock] acquired", {
          userId,
          endpoint,
          idempotencyKey,
          lockKey,
          token,
          ttlSeconds,
        });
        return {
          lockKey,
          token,
          release: () => releaseDistributedIdempotencyLock(redis, lockKey, token),
        };
      }

      // Lock is held by another replica — wait and retry. This is a normal
      // contention signal, not an outage.
    } catch (error) {
      logger.error(
        "[distributed-idempotency-lock] Redis SET failed; rejecting bet request (fail-closed)",
        {
          userId,
          endpoint,
          idempotencyKey,
          lockKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw new DistributedIdempotencyLockUnavailableError();
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  // Bounded wait elapsed while another replica still holds the lock. Do NOT
  // proceed: a request with this key is (or was) in flight.
  logger.warn(
    "[distributed-idempotency-lock] not acquired before timeout; rejecting bet request",
    { userId, endpoint, idempotencyKey, lockKey, acquireTimeoutMs },
  );
  throw new ConflictError(
    "A request with this idempotency key is already in progress.",
    ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
  );
}

/**
 * Executes `fn` while holding the distributed idempotency lock.
 *
 * The lock is held for the entire Prisma lock + bet processing + response
 * storage window, so a concurrent replica with the same key either replays
 * the stored DB response or is rejected — it never re-executes the bet.
 */
export async function withDistributedIdempotencyLock<T>(
  userId: string,
  endpoint: string,
  idempotencyKey: string,
  fn: () => Promise<T>,
  config: DistributedIdempotencyLockConfig = {},
): Promise<T> {
  const handle = await acquireDistributedIdempotencyLock(
    userId,
    endpoint,
    idempotencyKey,
    config,
  );
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * Releases the lock only if this token still owns it (Lua owner check),
 * preventing a stale holder from deleting a newer owner's lock.
 */
async function releaseDistributedIdempotencyLock(
  redis: any,
  lockKey: string,
  token: string,
): Promise<void> {
  try {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, {
      keys: [lockKey],
      arguments: [token],
    });
    logger.debug("[distributed-idempotency-lock] released", {
      lockKey,
      token,
    });
  } catch (error) {
    // Best-effort: the TTL auto-expires the lock, and the DB row remains the
    // source of truth for replay, so this cannot cause a double-acceptance.
    logger.warn(
      "[distributed-idempotency-lock] failed to release lock; TTL will expire it",
      {
        lockKey,
        token,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
