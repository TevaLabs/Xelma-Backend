import { FakeRedis } from './helpers/fake-redis';

// Shared across every module instance in this file, so the lock always talks
// to the same fake keyspace. Must be `mock`-prefixed for jest.mock hoisting.
const mockRedis = new FakeRedis();
let mockRedisAvailable = true;

jest.mock('../lib/redis', () => ({
   getConnectedRedisClient: async () => (mockRedisAvailable ? mockRedis : null),
   // The metrics registry exposes cache gauges via collect() callbacks, so the
   // module must still answer this even though the lock never calls it.
   getCacheMetrics: () => ({
      enabled: false,
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      bypasses: 0,
      errors: 0,
   }),
}));

import {
   describe,
   it,
   expect,
   beforeEach,
   afterEach,
   jest,
} from '@jest/globals';
import {
   DistributedLock,
   LockLostError,
   isLockLostError,
   withDistributedLock,
} from '../utils/distributed-lock';
import { metricsRegistry } from '../metrics/application.metrics';

const KEY = (name: string) => `xelma:lock:${name}`;

/** Reads a single Prometheus counter/gauge sample by name and labels. */
async function metricValue(
   name: string,
   labels: Record<string, string>
): Promise<number> {
   const metrics = await metricsRegistry.getMetricsAsJSON();
   const metric = metrics.find(m => m.name === name);
   if (!metric) return 0;

   const sample = (metric.values as Array<{
      labels: Record<string, string>;
      value: number;
   }>).find(v =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val)
   );

   return sample?.value ?? 0;
}

describe('DistributedLock', () => {
   const originalRedisUrl = process.env.REDIS_URL;

   beforeEach(() => {
      mockRedis.reset();
      mockRedisAvailable = true;
      process.env.REDIS_URL = 'redis://localhost:6379';
      delete process.env.SCHEDULER_LOCK_REQUIRED;
   });

   afterEach(() => {
      if (originalRedisUrl === undefined) {
         delete process.env.REDIS_URL;
      } else {
         process.env.REDIS_URL = originalRedisUrl;
      }
   });

   describe('acquire', () => {
      it('acquires a free lock and writes its owner id with a TTL', async () => {
         const lock = new DistributedLock('acquire-free', { ttlSeconds: 10 });

         const result = await lock.acquire();

         expect(result.acquired).toBe(true);
         expect(result.lockId).toBeDefined();
         expect(mockRedis.ownerOf(KEY('acquire-free'))).toBe(result.lockId);
         expect(mockRedis.ttlMs(KEY('acquire-free'))).toBeGreaterThan(0);

         await lock.release();
      });

      it('lets the next holder in after the first releases', async () => {
         const first = new DistributedLock('handoff', { ttlSeconds: 10 });
         await first.acquire();
         await first.release();

         const second = new DistributedLock('handoff', { ttlSeconds: 10 });
         expect((await second.acquire()).acquired).toBe(true);

         await second.release();
      });

      it('denies an overlapping run in the same process', async () => {
         const first = new DistributedLock('same-process', { ttlSeconds: 10 });
         await first.acquire();

         // Same process, same job name: an overlapping cron tick, not a
         // competing replica. Denied locally, without touching Redis.
         const overlapping = new DistributedLock('same-process', {
            ttlSeconds: 10,
         });
         expect((await overlapping.acquire()).acquired).toBe(false);

         await first.release();
      });

      it('keeps returning a plain denial when Redis commands fail', async () => {
         mockRedis.failAllCommands = new Error('CONNRESET');
         const lock = new DistributedLock('redis-error', {
            maxRetries: 1,
            retryDelayMs: 1,
         });

         const result = await lock.acquire();

         expect(result.acquired).toBe(false);
         expect(result.error).toContain('CONNRESET');
      });
   });

   describe('Redis availability policy', () => {
      it('fails closed when REDIS_URL is set but Redis is unreachable', async () => {
         mockRedisAvailable = false;
         const lock = new DistributedLock('fail-closed');

         const result = await lock.acquire();

         expect(result.acquired).toBe(false);
         expect(result.error).toBe('Redis unavailable');
      });

      it('runs unlocked in single-instance mode when REDIS_URL is unset', async () => {
         mockRedisAvailable = false;
         delete process.env.REDIS_URL;
         const lock = new DistributedLock('single-instance');

         const result = await lock.acquire();

         // Skipping here would mean a single-replica deploy never creates or
         // resolves a round at all.
         expect(result.acquired).toBe(true);
         expect(result.unlocked).toBe(true);

         await lock.release();
      });

      it('fails closed without Redis when SCHEDULER_LOCK_REQUIRED is set', async () => {
         mockRedisAvailable = false;
         delete process.env.REDIS_URL;
         process.env.SCHEDULER_LOCK_REQUIRED = 'true';
         const lock = new DistributedLock('lock-required');

         expect((await lock.acquire()).acquired).toBe(false);
      });
   });

   describe('release', () => {
      it('removes only its own key', async () => {
         const lock = new DistributedLock('release-own', { ttlSeconds: 10 });
         await lock.acquire();
         await lock.release();

         expect(mockRedis.ownerOf(KEY('release-own'))).toBeNull();
      });

      it('leaves a stolen key alone so the new leader keeps it', async () => {
         const lock = new DistributedLock('release-stolen', { ttlSeconds: 10 });
         await lock.acquire();

         mockRedis.steal(KEY('release-stolen'), 'other-instance');
         await lock.release();

         expect(mockRedis.ownerOf(KEY('release-stolen'))).toBe(
            'other-instance'
         );
      });

      it('is safe to call twice', async () => {
         const lock = new DistributedLock('double-release', { ttlSeconds: 10 });
         await lock.acquire();

         await lock.release();
         await expect(lock.release()).resolves.toBeUndefined();
      });

      it('swallows Redis errors, leaving the TTL to clean up', async () => {
         const lock = new DistributedLock('release-error', { ttlSeconds: 10 });
         await lock.acquire();

         mockRedis.failNextCommand = new Error('EVAL failed');
         await expect(lock.release()).resolves.toBeUndefined();
      });
   });

   describe('extend', () => {
      it('pushes out the TTL while still owned', async () => {
         const lock = new DistributedLock('extend-owned', {
            ttlSeconds: 10,
            autoRenew: false,
         });
         await lock.acquire();

         expect(await lock.extend()).toBe(true);
         expect(mockRedis.ttlMs(KEY('extend-owned'))).toBeGreaterThan(9_000);

         await lock.release();
      });

      it('reports loss and marks the lock lost when the key was stolen', async () => {
         const lock = new DistributedLock('extend-stolen', {
            ttlSeconds: 10,
            autoRenew: false,
         });
         await lock.acquire();

         mockRedis.steal(KEY('extend-stolen'), 'other-instance');

         expect(await lock.extend()).toBe(false);
         expect(lock.handle.isHeld()).toBe(false);
         expect(lock.handle.lostReason()).toBe('stolen');
      });

      it('reports loss when the key expired', async () => {
         const lock = new DistributedLock('extend-expired', {
            ttlSeconds: 10,
            autoRenew: false,
         });
         await lock.acquire();

         mockRedis.forceExpire(KEY('extend-expired'));

         expect(await lock.extend()).toBe(false);
         expect(lock.handle.lostReason()).toBe('expired');
      });

      it('returns false without losing the lock on a transient error', async () => {
         const lock = new DistributedLock('extend-error', {
            ttlSeconds: 10,
            autoRenew: false,
         });
         await lock.acquire();

         mockRedis.failNextCommand = new Error('EVAL failed');

         expect(await lock.extend()).toBe(false);
         expect(lock.handle.isHeld()).toBe(true);

         await lock.release();
      });
   });

   describe('LockLostError', () => {
      it('is recognised by isLockLostError', () => {
         expect(isLockLostError(new LockLostError('job', 'stolen'))).toBe(true);
         expect(isLockLostError(new Error('boom'))).toBe(false);
         expect(isLockLostError(null)).toBe(false);
      });

      it('is recognised across realms via its code', () => {
         expect(isLockLostError({ code: 'LOCK_LOST' })).toBe(true);
      });
   });

   describe('withDistributedLock', () => {
      it('runs the function and returns its value', async () => {
         const result = await withDistributedLock(
            'run-fn',
            async () => 'done',
            { ttlSeconds: 10 }
         );

         expect(result).toBe('done');
      });

      it('hands the function a handle that reports leadership', async () => {
         await withDistributedLock(
            'handle-held',
            async lock => {
               expect(lock.lockName).toBe('handle-held');
               expect(lock.isHeld()).toBe(true);
               expect(() => lock.assertHeld()).not.toThrow();
            },
            { ttlSeconds: 10 }
         );
      });

      it('returns null and skips the function when the lock is already taken', async () => {
         const holder = new DistributedLock('taken', { ttlSeconds: 10 });
         await holder.acquire();

         const fn = jest.fn(async () => 'ran');
         const result = await withDistributedLock('taken', fn, {
            ttlSeconds: 10,
            maxRetries: 1,
            retryDelayMs: 1,
         });

         expect(result).toBeNull();
         expect(fn).not.toHaveBeenCalled();

         await holder.release();
      });

      it('releases the lock even when the function throws', async () => {
         await expect(
            withDistributedLock(
               'throwing',
               async () => {
                  throw new Error('job failed');
               },
               { ttlSeconds: 10 }
            )
         ).rejects.toThrow('job failed');

         expect(mockRedis.ownerOf(KEY('throwing'))).toBeNull();
      });

      it('swallows LockLostError and returns null', async () => {
         const result = await withDistributedLock(
            'lost-mid-job',
            async lock => {
               throw new LockLostError(lock.lockName, 'stolen');
            },
            { ttlSeconds: 10 }
         );

         expect(result).toBeNull();
      });

      it('discards the result when the lock was lost before the job returned', async () => {
         const result = await withDistributedLock(
            'lost-silently',
            async () => {
               // The job never checked assertHeld, so it finished "successfully"
               // while another instance took over.
               mockRedis.steal(KEY('lost-silently'), 'other-instance');
               return 'stale-result';
            },
            { ttlSeconds: 10 }
         );

         // No heartbeat had a chance to fire, so only the post-run ownership
         // check can catch this. The caller must not treat it as a clean run.
         expect(result).toBeNull();
      });
   });

   describe('metrics', () => {
      it('counts acquisitions and denials per lock name', async () => {
         const before = await metricValue(
            'distributed_lock_acquisitions_total',
            { lock: 'metric-lock', outcome: 'acquired' }
         );

         const holder = new DistributedLock('metric-lock', { ttlSeconds: 10 });
         await holder.acquire();

         expect(
            await metricValue('distributed_lock_acquisitions_total', {
               lock: 'metric-lock',
               outcome: 'acquired',
            })
         ).toBe(before + 1);

         expect(
            await metricValue('distributed_locks_held', {
               lock: 'metric-lock',
            })
         ).toBe(1);

         await holder.release();

         expect(
            await metricValue('distributed_locks_held', {
               lock: 'metric-lock',
            })
         ).toBe(0);
      });

      it('counts a lock lost to another instance as a steal', async () => {
         const lock = new DistributedLock('steal-metric', {
            ttlSeconds: 10,
            autoRenew: false,
         });
         await lock.acquire();

         mockRedis.steal(KEY('steal-metric'), 'other-instance');
         await lock.extend();

         expect(
            await metricValue('distributed_lock_lost_total', {
               lock: 'steal-metric',
               reason: 'stolen',
            })
         ).toBe(1);
      });

      it('records how long the lock was held', async () => {
         const lock = new DistributedLock('held-duration', { ttlSeconds: 10 });
         await lock.acquire();
         await lock.release();

         const metrics = await metricsRegistry.getMetricsAsJSON();
         const histogram = metrics.find(
            m => m.name === 'distributed_lock_held_seconds'
         );

         expect(histogram).toBeDefined();
         expect(
            (histogram!.values as Array<{ labels: Record<string, string> }>).some(
               v => v.labels.lock === 'held-duration'
            )
         ).toBe(true);
      });
   });
});
