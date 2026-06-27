import { createClient } from 'redis';
import logger from './logger';

/**
 * Distributed lock configuration
 */
export interface DistributedLockConfig {
   ttlSeconds?: number;
   retryDelayMs?: number;
   maxRetries?: number;
}

/**
 * Result of a lock acquisition attempt
 */
export interface LockAcquisitionResult {
   acquired: boolean;
   lockId?: string;
   error?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DistributedLockConfig = {
   ttlSeconds: 30,
   retryDelayMs: 100,
   maxRetries: 3,
};

/**
 * Distributed lock manager using Redis
 * Prevents duplicate cron job execution across multiple backend instances
 *
 * Usage:
 * ```typescript
 * const lock = new DistributedLock('round-creation', { ttlSeconds: 60 });
 * const result = await lock.acquire();
 *
 * if (result.acquired) {
 *   try {
 *     await doWork();
 *   } finally {
 *     await lock.release();
 *   }
 * }
 * ```
 */
export class DistributedLock {
   private lockKey: string;
   private lockId: string;
   private config: DistributedLockConfig;
   private redisClient: any = null;

   constructor(lockName: string, config: DistributedLockConfig = {}) {
      this.lockKey = `xelma:lock:${lockName}`;
      this.lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      this.config = { ...DEFAULT_CONFIG, ...config };
   }

   /**
    * Acquires the distributed lock
    * Returns true if lock was acquired, false if already held by another instance
    *
    * @returns Lock acquisition result
    */
   async acquire(): Promise<LockAcquisitionResult> {
      try {
         const client = await this.getRedisClient();
         if (!client) {
            return {
               acquired: false,
               error: 'Redis unavailable',
            };
         }

         const ttl = this.config.ttlSeconds || 30;

         // Try to acquire lock with retries
         for (
            let attempt = 0;
            attempt < (this.config.maxRetries || 3);
            attempt++
         ) {
            try {
               // Use SET NX (only if not exists) with EX (expiration) for atomic lock acquisition
               const result = await client.set(this.lockKey, this.lockId, {
                  NX: true,
                  EX: ttl,
               });

               if (result === 'OK') {
                  logger.debug('Distributed lock acquired', {
                     lockKey: this.lockKey,
                     lockId: this.lockId,
                     ttl,
                  });

                  this.redisClient = client;
                  return { acquired: true, lockId: this.lockId };
               }

               // Lock is held by another instance
               if (attempt < (this.config.maxRetries || 3) - 1) {
                  // Retry with backoff
                  await new Promise(resolve =>
                     setTimeout(resolve, this.config.retryDelayMs || 100)
                  );
               }
            } catch (error) {
               logger.warn('Error acquiring lock, retrying', {
                  lockKey: this.lockKey,
                  attempt,
                  error:
                     error instanceof Error ? error.message : 'Unknown error',
               });

               if (attempt < (this.config.maxRetries || 3) - 1) {
                  await new Promise(resolve =>
                     setTimeout(resolve, this.config.retryDelayMs || 100)
                  );
               }
            }
         }

         logger.debug('Failed to acquire distributed lock after retries', {
            lockKey: this.lockKey,
            maxRetries: this.config.maxRetries,
         });

         return { acquired: false };
      } catch (error) {
         logger.error('Unexpected error acquiring lock', {
            lockKey: this.lockKey,
            error: error instanceof Error ? error.message : 'Unknown error',
         });

         return {
            acquired: false,
            error: error instanceof Error ? error.message : 'Unknown error',
         };
      }
   }

   /**
    * Releases the distributed lock
    * Only releases if the lock is still held by this instance
    */
   async release(): Promise<void> {
      try {
         const client = await this.getRedisClient();
         if (!client) {
            return;
         }

         // Use Lua script to ensure we only delete our own lock
         // This prevents accidentally releasing a lock acquired by another instance
         const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

         await client.eval(script, {
            keys: [this.lockKey],
            arguments: [this.lockId],
         });

         logger.debug('Distributed lock released', {
            lockKey: this.lockKey,
            lockId: this.lockId,
         });
      } catch (error) {
         logger.warn('Error releasing lock', {
            lockKey: this.lockKey,
            error: error instanceof Error ? error.message : 'Unknown error',
         });
      }
   }

   /**
    * Extends the lock TTL (useful for long-running operations)
    */
   async extend(): Promise<boolean> {
      try {
         const client = await this.getRedisClient();
         if (!client) {
            return false;
         }

         const ttl = this.config.ttlSeconds || 30;

         // Use Lua script to extend only if we still own the lock
         const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

         const result = await client.eval(script, {
            keys: [this.lockKey],
            arguments: [this.lockId, ttl.toString()],
         });

         return result === 1;
      } catch (error) {
         logger.warn('Error extending lock', {
            lockKey: this.lockKey,
            error: error instanceof Error ? error.message : 'Unknown error',
         });

         return false;
      }
   }

   /**
    * Gets the Redis client, creating one if needed
    */
   private async getRedisClient(): Promise<any> {
      if (this.redisClient) {
         return this.redisClient;
      }

      try {
         const redisUrl = process.env.REDIS_URL;
         if (!redisUrl) {
            return null;
         }

         const client = createClient({
            url: redisUrl,
            socket: {
               connectTimeout: 2000,
            },
         });

         await client.connect();
         this.redisClient = client;
         return client;
      } catch (error) {
         logger.warn('Failed to connect to Redis for distributed lock', {
            error: error instanceof Error ? error.message : 'Unknown error',
         });

         return null;
      }
   }
}

/**
 * Executes a function with distributed lock protection
 * Ensures only one instance runs the function at a time
 *
 * @param lockName - Name of the lock
 * @param fn - Function to execute
 * @param config - Lock configuration
 * @returns Result of the function, or null if lock could not be acquired
 *
 * @example
 * const result = await withDistributedLock(
 *   'round-creation',
 *   async () => {
 *     await createRound();
 *   },
 *   { ttlSeconds: 60 }
 * );
 */
export async function withDistributedLock<T>(
   lockName: string,
   fn: () => Promise<T>,
   config: DistributedLockConfig = {}
): Promise<T | null> {
   const lock = new DistributedLock(lockName, config);

   const result = await lock.acquire();
   if (!result.acquired) {
      logger.debug('Could not acquire lock, skipping operation', {
         lockName,
      });
      return null;
   }

   try {
      return await fn();
   } finally {
      await lock.release();
   }
}
