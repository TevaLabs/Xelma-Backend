import { FakeRedis } from './helpers/fake-redis';

/**
 * Multi-worker safety tests for the scheduler distributed lock (Issue #601).
 *
 * Each "worker" is a separately-loaded copy of the lock module, so it has its
 * own in-process guard exactly like a separate Render replica would — the only
 * thing they share is the fake Redis keyspace. That makes these tests exercise
 * real cross-instance mutual exclusion rather than the same-process fast path.
 */

// `mock`-prefixed so jest.mock's hoisting allows the reference. Shared by every
// isolated module registry, which is what makes the workers contend.
const mockRedis = new FakeRedis();

const mockLockMetrics = {
   distributedLockAcquisitionsTotal: { inc: jest.fn() },
   distributedLockRenewalsTotal: { inc: jest.fn() },
   distributedLockLostTotal: { inc: jest.fn() },
   distributedLocksHeld: { inc: jest.fn(), dec: jest.fn() },
   distributedLockHeldSeconds: { observe: jest.fn() },
};

jest.mock('../lib/redis', () => ({
   getConnectedRedisClient: async () => mockRedis,
}));

jest.mock('../metrics/application.metrics', () => mockLockMetrics);

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type * as LockModule from '../utils/distributed-lock';

type Worker = typeof LockModule;

const KEY = (name: string) => `xelma:lock:${name}`;

/**
 * Loads an independent copy of the lock module, standing in for one replica.
 * Isolation matters: the module-level in-process guard must NOT be shared, or
 * the workers would block each other locally and never reach Redis.
 */
function spawnWorker(): Worker {
   let worker!: Worker;
   jest.isolateModules(() => {
      worker = require('../utils/distributed-lock') as Worker;
   });
   return worker;
}

function sleep(ms: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms));
}

/** Tracks concurrent entries into a critical section. */
function makeOverlapDetector() {
   let active = 0;
   let maxActive = 0;
   const order: string[] = [];

   return {
      order,
      get maxActive() {
         return maxActive;
      },
      async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
         active += 1;
         maxActive = Math.max(maxActive, active);
         order.push(`enter:${label}`);
         try {
            return await fn();
         } finally {
            order.push(`exit:${label}`);
            active -= 1;
         }
      },
   };
}

describe('Distributed lock — multi-worker safety', () => {
   const originalRedisUrl = process.env.REDIS_URL;

   beforeEach(() => {
      mockRedis.reset();
      process.env.REDIS_URL = 'redis://localhost:6379';
      Object.values(mockLockMetrics).forEach(metric =>
         Object.values(metric).forEach(fn => (fn as jest.Mock).mockClear())
      );
   });

   afterAll(() => {
      if (originalRedisUrl === undefined) {
         delete process.env.REDIS_URL;
      } else {
         process.env.REDIS_URL = originalRedisUrl;
      }
   });

   describe('mutual exclusion', () => {
      it('never lets two workers run the same job concurrently', async () => {
         const workerA = spawnWorker();
         const workerB = spawnWorker();
         const detector = makeOverlapDetector();

         const job = (label: string) => async () =>
            detector.run(label, async () => {
               await sleep(50);
               return label;
            });

         const [a, b] = await Promise.all([
            workerA.withDistributedLock('critical-job', job('A'), {
               ttlSeconds: 10,
               maxRetries: 1,
               retryDelayMs: 1,
            }),
            workerB.withDistributedLock('critical-job', job('B'), {
               ttlSeconds: 10,
               maxRetries: 1,
               retryDelayMs: 1,
            }),
         ]);

         expect(detector.maxActive).toBe(1);

         // Exactly one worker ran; the other skipped its tick.
         const winners = [a, b].filter(r => r !== null);
         expect(winners).toHaveLength(1);
         expect(detector.order).toHaveLength(2);
      });

      it('serialises many workers contending on one tick', async () => {
         const workers = Array.from({ length: 5 }, () => spawnWorker());
         const detector = makeOverlapDetector();

         const results = await Promise.all(
            workers.map((worker, index) =>
               worker.withDistributedLock(
                  'busy-job',
                  async () =>
                     detector.run(`w${index}`, async () => {
                        await sleep(30);
                        return index;
                     }),
                  { ttlSeconds: 10, maxRetries: 1, retryDelayMs: 1 }
               )
            )
         );

         expect(detector.maxActive).toBe(1);
         expect(results.filter(r => r !== null)).toHaveLength(1);
      });

      it('hands the lock to a waiting worker once the leader releases', async () => {
         const leader = spawnWorker();
         const follower = spawnWorker();
         const detector = makeOverlapDetector();

         const leaderRun = leader.withDistributedLock(
            'handoff-job',
            async () =>
               detector.run('leader', async () => {
                  await sleep(40);
                  return 'leader';
               }),
            { ttlSeconds: 10 }
         );

         // Retries long enough to outlast the leader's run.
         const followerRun = follower.withDistributedLock(
            'handoff-job',
            async () => detector.run('follower', async () => 'follower'),
            { ttlSeconds: 10, maxRetries: 30, retryDelayMs: 10 }
         );

         expect(await leaderRun).toBe('leader');
         expect(await followerRun).toBe('follower');

         // Both ran, but strictly one after the other.
         expect(detector.maxActive).toBe(1);
         expect(detector.order).toEqual([
            'enter:leader',
            'exit:leader',
            'enter:follower',
            'exit:follower',
         ]);
      });
   });

   describe('heartbeat renewal', () => {
      it('keeps a job running past its TTL without losing the lock', async () => {
         const worker = spawnWorker();
         let heldThroughout = true;

         const result = await worker.withDistributedLock(
            'long-job',
            async lock => {
               // Four times the TTL: without renewal the key would have expired.
               for (let i = 0; i < 8; i++) {
                  await sleep(50);
                  if (!lock.isHeld()) heldThroughout = false;
               }
               return 'finished';
            },
            { ttlSeconds: 0.3, renewIntervalSeconds: 0.1 }
         );

         expect(result).toBe('finished');
         expect(heldThroughout).toBe(true);
         expect(
            mockLockMetrics.distributedLockRenewalsTotal.inc
         ).toHaveBeenCalledWith({ lock: 'long-job', outcome: 'renewed' });
      });

      it('blocks a competing worker for the whole renewed run', async () => {
         const leader = spawnWorker();
         const rival = spawnWorker();
         const detector = makeOverlapDetector();

         const leaderRun = leader.withDistributedLock(
            'renewed-job',
            async () =>
               detector.run('leader', async () => {
                  await sleep(250);
                  return 'leader';
               }),
            { ttlSeconds: 0.15, renewIntervalSeconds: 0.1 }
         );

         // Attempt a takeover mid-run, well after the un-renewed TTL would have lapsed.
         await sleep(180);
         const rivalRun = await rival.withDistributedLock(
            'renewed-job',
            async () => detector.run('rival', async () => 'rival'),
            { ttlSeconds: 0.15, maxRetries: 1, retryDelayMs: 1 }
         );

         expect(rivalRun).toBeNull();
         expect(await leaderRun).toBe('leader');
         expect(detector.maxActive).toBe(1);
      });
   });

   describe('lock loss aborts unsafe work', () => {
      it('stops a batch at the next checkpoint when the lock is stolen', async () => {
         const worker = spawnWorker();
         const processed: number[] = [];

         const result = await worker.withDistributedLock(
            'stolen-job',
            async lock => {
               for (let i = 0; i < 10; i++) {
                  // Fail closed: never write past the point we stopped leading.
                  lock.assertHeld();
                  processed.push(i);

                  if (i === 2) {
                     // Another replica takes the key, as it would after a stall.
                     mockRedis.steal(KEY('stolen-job'), 'other-instance');
                  }
                  await sleep(40);
               }
               return 'completed';
            },
            { ttlSeconds: 1, renewIntervalSeconds: 0.1 }
         );

         expect(result).toBeNull();
         expect(processed).toEqual([0, 1, 2]);
         expect(processed).not.toContain(9);

         expect(mockLockMetrics.distributedLockLostTotal.inc).toHaveBeenCalledWith(
            { lock: 'stolen-job', reason: 'stolen' }
         );
      });

      it('aborts when the key expired instead of being taken', async () => {
         const worker = spawnWorker();
         let reason: string | null = null;

         const result = await worker.withDistributedLock(
            'expired-job',
            async lock => {
               await sleep(30);
               mockRedis.forceExpire(KEY('expired-job'));
               await sleep(200);
               reason = lock.lostReason();
               lock.assertHeld();
               return 'completed';
            },
            { ttlSeconds: 1, renewIntervalSeconds: 0.1 }
         );

         expect(result).toBeNull();
         expect(reason).toBe('expired');
         expect(mockLockMetrics.distributedLockLostTotal.inc).toHaveBeenCalledWith(
            { lock: 'expired-job', reason: 'expired' }
         );
      });

      it('aborts the signal so cancellable waits can unblock', async () => {
         const worker = spawnWorker();
         let aborted = false;

         await worker.withDistributedLock(
            'signal-job',
            async lock => {
               lock.signal.addEventListener('abort', () => {
                  aborted = true;
               });
               mockRedis.steal(KEY('signal-job'), 'other-instance');
               await sleep(250);
               lock.assertHeld();
            },
            { ttlSeconds: 1, renewIntervalSeconds: 0.1 }
         );

         expect(aborted).toBe(true);
      });

      it('does not release a key that now belongs to the new leader', async () => {
         const worker = spawnWorker();

         await worker.withDistributedLock(
            'no-steal-release',
            async lock => {
               mockRedis.steal(KEY('no-steal-release'), 'other-instance');
               await sleep(200);
               lock.assertHeld();
            },
            { ttlSeconds: 1, renewIntervalSeconds: 0.1 }
         );

         // The new leader must still hold its lock after the loser cleans up.
         expect(mockRedis.ownerOf(KEY('no-steal-release'))).toBe(
            'other-instance'
         );
      });

      it('lets the new leader run its own job after a steal', async () => {
         const loser = spawnWorker();
         const winner = spawnWorker();
         const detector = makeOverlapDetector();

         const loserRun = loser.withDistributedLock(
            'takeover-job',
            async lock =>
               detector.run('loser', async () => {
                  for (let i = 0; i < 10; i++) {
                     lock.assertHeld();
                     await sleep(30);
                  }
                  return 'loser';
               }),
            { ttlSeconds: 1, renewIntervalSeconds: 0.1 }
         );

         // Simulate the leader stalling long enough for its key to lapse.
         await sleep(60);
         mockRedis.forceExpire(KEY('takeover-job'));

         const winnerRun = await winner.withDistributedLock(
            'takeover-job',
            async () => detector.run('winner', async () => 'winner'),
            { ttlSeconds: 1, maxRetries: 3, retryDelayMs: 10 }
         );

         expect(winnerRun).toBe('winner');
         expect(await loserRun).toBeNull();
      });
   });

   describe('max hold watchdog', () => {
      it('aborts a job that holds the lock past maxHoldSeconds', async () => {
         const worker = spawnWorker();
         let iterations = 0;

         const result = await worker.withDistributedLock(
            'hung-job',
            async lock => {
               for (let i = 0; i < 50; i++) {
                  lock.assertHeld();
                  iterations += 1;
                  await sleep(20);
               }
               return 'completed';
            },
            {
               ttlSeconds: 5,
               renewIntervalSeconds: 0.1,
               maxHoldSeconds: 0.3,
            }
         );

         expect(result).toBeNull();
         expect(iterations).toBeLessThan(50);
         expect(mockLockMetrics.distributedLockLostTotal.inc).toHaveBeenCalledWith(
            { lock: 'hung-job', reason: 'max_hold_exceeded' }
         );
      });

      it('frees the lock for another worker once the watchdog fires', async () => {
         const hung = spawnWorker();
         const next = spawnWorker();

         await hung.withDistributedLock(
            'watchdog-handoff',
            async lock => {
               for (let i = 0; i < 50; i++) {
                  lock.assertHeld();
                  await sleep(20);
               }
            },
            { ttlSeconds: 5, renewIntervalSeconds: 0.1, maxHoldSeconds: 0.3 }
         );

         const result = await next.withDistributedLock(
            'watchdog-handoff',
            async () => 'took-over',
            { ttlSeconds: 5, maxRetries: 3, retryDelayMs: 10 }
         );

         expect(result).toBe('took-over');
      });
   });

   describe('Redis outage', () => {
      it('gives up leadership after repeated renewal failures', async () => {
         const worker = spawnWorker();

         const result = await worker.withDistributedLock(
            'outage-job',
            async lock => {
               await sleep(30);
               mockRedis.failAllCommands = new Error('CONNRESET');
               await sleep(400);
               lock.assertHeld();
               return 'completed';
            },
            {
               ttlSeconds: 1,
               renewIntervalSeconds: 0.1,
               maxRenewFailures: 2,
            }
         );

         expect(result).toBeNull();
         expect(mockLockMetrics.distributedLockLostTotal.inc).toHaveBeenCalledWith(
            { lock: 'outage-job', reason: 'redis_error' }
         );

         mockRedis.failAllCommands = null;
      });

      it('tolerates a single renewal blip without aborting', async () => {
         const worker = spawnWorker();

         const result = await worker.withDistributedLock(
            'blip-job',
            async lock => {
               mockRedis.failNextCommand = new Error('transient');
               await sleep(300);
               lock.assertHeld();
               return 'completed';
            },
            {
               ttlSeconds: 5,
               renewIntervalSeconds: 0.1,
               maxRenewFailures: 3,
            }
         );

         expect(result).toBe('completed');
      });
   });

   describe('metrics', () => {
      it('records the winner as acquired and the loser as denied', async () => {
         const workerA = spawnWorker();
         const workerB = spawnWorker();

         await Promise.all([
            workerA.withDistributedLock(
               'metric-job',
               async () => sleep(40),
               { ttlSeconds: 10, maxRetries: 1, retryDelayMs: 1 }
            ),
            workerB.withDistributedLock(
               'metric-job',
               async () => sleep(40),
               { ttlSeconds: 10, maxRetries: 1, retryDelayMs: 1 }
            ),
         ]);

         const outcomes = mockLockMetrics.distributedLockAcquisitionsTotal.inc.mock.calls
            .map(call => call[0] as { lock: string; outcome: string })
            .filter(labels => labels.lock === 'metric-job')
            .map(labels => labels.outcome);

         expect(outcomes).toContain('acquired');
         expect(outcomes).toContain('denied');
         expect(outcomes.filter(o => o === 'acquired')).toHaveLength(1);
      });

      it('observes hold duration when the lock is released', async () => {
         const worker = spawnWorker();

         await worker.withDistributedLock(
            'duration-job',
            async () => sleep(30),
            { ttlSeconds: 10 }
         );

         expect(
            mockLockMetrics.distributedLockHeldSeconds.observe
         ).toHaveBeenCalledWith({ lock: 'duration-job' }, expect.any(Number));
      });
   });
});
