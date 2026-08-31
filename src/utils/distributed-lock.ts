import { setTimeout as delay } from 'timers/promises';
import logger from './logger';
import { getConnectedRedisClient } from '../lib/redis';
import {
   distributedLockAcquisitionsTotal,
   distributedLockHeldSeconds,
   distributedLockLostTotal,
   distributedLockRenewalsTotal,
   distributedLocksHeld,
} from '../metrics/application.metrics';

/**
 * Single-leader distributed lock for cron-driven work (Issue #601).
 *
 * Every critical scheduled job (round creation/close, oracle resolve,
 * retention sweeps, outbox drain) runs on every Render replica. Without a
 * lock, two replicas can create duplicate rounds or resolve the same round
 * twice. This module makes exactly one replica the leader for the duration
 * of each job run.
 *
 * ## Why a TTL alone is not enough
 *
 * The original implementation acquired a fixed-TTL key and hoped the job
 * finished first. It did not: `oracle-resolve-rounds` held a 60 s lock while
 * looping N rounds with up to 3 attempts and 5 s/10 s backoff sleeps each, so
 * a busy tick could run for minutes. Once the TTL expired, a second replica
 * acquired the "free" lock and resolved the same rounds concurrently, while
 * the first replica kept writing as if it were still the leader.
 *
 * Two mechanisms fix that, and they must be used together:
 *
 * 1. **Heartbeat renewal** — a background timer re-`PEXPIRE`s the key every
 *    `ttl/3`, so the TTL bounds *failure detection* (how long a dead leader
 *    blocks the next one), not job duration. TTLs no longer have to be
 *    guessed from worst-case runtime.
 * 2. **Fail-closed abort** — a renewal that finds the key missing (expired)
 *    or owned by a different `lockId` (stolen) marks the lock lost and aborts
 *    the job. Long jobs call {@link LockHandle.assertHeld} between units of
 *    work so they stop *before* the next unsafe write instead of racing the
 *    new leader.
 *
 * A `maxHoldSeconds` watchdog caps how long the heartbeat will keep a lock
 * alive, so a hung job cannot renew forever and starve every other replica.
 *
 * ## Redis availability policy
 *
 * - `REDIS_URL` set, Redis reachable -> normal distributed locking.
 * - `REDIS_URL` set, Redis unreachable -> **fail closed**, the job is skipped.
 *   A configured Redis means the operator intends to run multiple replicas,
 *   so running unlocked would risk exactly the duplicate work this prevents.
 * - `REDIS_URL` unset -> single-instance mode: the job runs behind an
 *   in-process mutex with a warning. Skipping instead would mean a
 *   single-replica deploy never creates or resolves a round at all.
 *   Set `SCHEDULER_LOCK_REQUIRED=true` to fail closed here too.
 *
 * @see docs/multi-instance-deployment.md
 */

/** Why a held lock stopped being held. */
export type LockLostReason =
   | 'stolen'
   | 'expired'
   | 'redis_error'
   | 'max_hold_exceeded';

/** Machine-readable code carried by {@link LockLostError}. */
export const LOCK_LOST = 'LOCK_LOST';

/**
 * Thrown by {@link LockHandle.assertHeld} once the lock is no longer held.
 *
 * Jobs should let this propagate: it means another replica may already be the
 * leader, so continuing to write is unsafe.
 */
export class LockLostError extends Error {
   readonly code = LOCK_LOST;

   constructor(
      readonly lockName: string,
      readonly reason: LockLostReason
   ) {
      super(
         `Distributed lock "${lockName}" lost (${reason}); aborting to avoid concurrent execution`
      );
      this.name = 'LockLostError';
   }
}

/** Type guard for {@link LockLostError} across module/realm boundaries. */
export function isLockLostError(error: unknown): error is LockLostError {
   return (
      error instanceof LockLostError ||
      (typeof error === 'object' &&
         error !== null &&
         (error as { code?: unknown }).code === LOCK_LOST)
   );
}

/** Distributed lock configuration. */
export interface DistributedLockConfig {
   /**
    * Seconds before Redis expires the key. With renewal enabled this bounds
    * how long a crashed leader blocks the next one — not how long the job may
    * run. Keep it comfortably above `renewIntervalSeconds`.
    */
   ttlSeconds?: number;
   /** Delay between acquisition attempts while another replica holds it. */
   retryDelayMs?: number;
   /** Acquisition attempts before giving up (the loser simply skips the tick). */
   maxRetries?: number;
   /** Renew the TTL in the background while the job runs. Default `true`. */
   autoRenew?: boolean;
   /**
    * Renewal period. Defaults to `ttlSeconds / 3`, and is always clamped to at
    * most half the TTL so a renewal can never race its own expiry.
    */
   renewIntervalSeconds?: number;
   /**
    * Consecutive renewal *errors* (Redis unreachable, command failed) tolerated
    * before the lock is declared lost. A definitive "not ours" answer is never
    * tolerated. Default `2`.
    */
   maxRenewFailures?: number;
   /**
    * Hard cap on hold time. Once exceeded the heartbeat stops and the job is
    * aborted, so a hung job cannot hold leadership forever.
    * Defaults to `ttlSeconds * 20`.
    */
   maxHoldSeconds?: number;
}

/** Result of a lock acquisition attempt. */
export interface LockAcquisitionResult {
   acquired: boolean;
   lockId?: string;
   /** True when the lock was skipped because Redis is not configured. */
   unlocked?: boolean;
   error?: string;
}

/**
 * Live view of the lock, handed to the protected function.
 *
 * Long-running jobs must call {@link assertHeld} between units of work (per
 * round, per batch) so lock loss aborts before the next unsafe write.
 */
export interface LockHandle {
   readonly lockName: string;
   readonly lockId: string;
   /** Aborts as soon as the lock is lost; use for cancellable awaits. */
   readonly signal: AbortSignal;
   /** True while this instance is still the verified leader. */
   isHeld(): boolean;
   /** Why the lock was lost, or `null` while still held. */
   lostReason(): LockLostReason | null;
   /** Throws {@link LockLostError} if the lock is no longer held. */
   assertHeld(): void;
}

const DEFAULT_CONFIG: Required<
   Pick<DistributedLockConfig, 'ttlSeconds' | 'retryDelayMs' | 'maxRetries'>
> = {
   ttlSeconds: 30,
   retryDelayMs: 100,
   maxRetries: 3,
};

const DEFAULT_MAX_RENEW_FAILURES = 2;
const MAX_HOLD_TTL_MULTIPLIER = 20;

/**
 * Floor for the renewal and max-hold timers. Guards against a misconfiguration
 * that would hammer Redis with heartbeats, while staying low enough that tests
 * can drive a full renew/steal/abort cycle without second-long waits.
 */
const MIN_TIMER_MS = 100;

/**
 * Renew only if we still own the key, and report *why* we do not.
 *
 * Return codes are distinguished on purpose: an expired key means we were too
 * slow (or Redis evicted it) and a stolen key means another replica is already
 * the leader. Both abort the job, but they need different alerts.
 */
const RENEW_SCRIPT = `
local current = redis.call("get", KEYS[1])
if current == false then
  return 0
end
if current ~= ARGV[1] then
  return -1
end
redis.call("pexpire", KEYS[1], ARGV[2])
return 1
`;

/** Delete only our own key, so a stolen lock is never released by the loser. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * In-process guard held for the lifetime of a job.
 *
 * Redis prevents cross-replica overlap; this prevents same-process overlap,
 * which happens whenever a cron tick fires while the previous run is still
 * going. It is also the only protection available in single-instance mode.
 */
const inProcessLocks = new Set<string>();

function isLockRequired(): boolean {
   return process.env.SCHEDULER_LOCK_REQUIRED === 'true';
}

/**
 * Distributed lock manager backed by the shared Redis client.
 *
 * @example
 * ```typescript
 * const lock = new DistributedLock('round-creation', { ttlSeconds: 30 });
 * const result = await lock.acquire();
 * if (result.acquired) {
 *   try {
 *     for (const round of rounds) {
 *       lock.handle.assertHeld();
 *       await resolve(round);
 *     }
 *   } finally {
 *     await lock.release();
 *   }
 * }
 * ```
 */
export class DistributedLock {
   private readonly lockKey: string;
   private readonly lockId: string;
   private readonly config: DistributedLockConfig;

   private renewTimer: NodeJS.Timeout | null = null;
   private readonly abortController = new AbortController();
   private held = false;
   private lost: LockLostReason | null = null;
   private acquiredAtMs = 0;
   /** True once the key was taken, even after the lock is marked lost. */
   private everAcquired = false;
   private consecutiveRenewFailures = 0;
   private renewing = false;
   /** True when running without Redis (single-instance mode). */
   private degraded = false;

   readonly handle: LockHandle;

   constructor(
      readonly lockName: string,
      config: DistributedLockConfig = {}
   ) {
      this.lockKey = `xelma:lock:${lockName}`;
      this.lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      this.config = { ...DEFAULT_CONFIG, ...config };

      this.handle = {
         lockName,
         lockId: this.lockId,
         signal: this.abortController.signal,
         isHeld: () => this.held && this.lost === null,
         lostReason: () => this.lost,
         assertHeld: () => {
            if (this.lost !== null) {
               throw new LockLostError(this.lockName, this.lost);
            }
            if (!this.held) {
               throw new LockLostError(this.lockName, 'expired');
            }
         },
      };
   }

   private get ttlSeconds(): number {
      return this.config.ttlSeconds ?? DEFAULT_CONFIG.ttlSeconds;
   }

   private get renewIntervalMs(): number {
      const fromConfig = this.config.renewIntervalSeconds;
      const seconds = fromConfig ?? this.ttlSeconds / 3;

      // Never renew at or above the TTL: the key would routinely expire
      // between beats and the lock would appear stolen under normal operation.
      const capped = Math.min(seconds * 1000, (this.ttlSeconds * 1000) / 2);
      return Math.max(MIN_TIMER_MS, Math.floor(capped));
   }

   private get maxHoldMs(): number {
      const seconds =
         this.config.maxHoldSeconds ?? this.ttlSeconds * MAX_HOLD_TTL_MULTIPLIER;
      return Math.max(MIN_TIMER_MS, Math.floor(seconds * 1000));
   }

   /**
    * Acquires the lock, starting the renewal heartbeat on success.
    *
    * Never throws: a failed acquisition means "another replica owns this tick",
    * which is a normal outcome, not an error.
    */
   async acquire(): Promise<LockAcquisitionResult> {
      if (inProcessLocks.has(this.lockKey)) {
         // A previous tick of this same job is still running here.
         distributedLockAcquisitionsTotal.inc({
            lock: this.lockName,
            outcome: 'denied_local',
         });
         logger.debug('Distributed lock denied: previous run still in progress', {
            lockName: this.lockName,
         });
         return { acquired: false };
      }

      let client;
      try {
         client = await getConnectedRedisClient();
      } catch (error) {
         client = null;
         logger.warn('Failed to reach Redis for distributed lock', {
            lockName: this.lockName,
            error: error instanceof Error ? error.message : String(error),
         });
      }

      if (!client) {
         return this.acquireWithoutRedis();
      }

      const maxRetries = Math.max(1, this.config.maxRetries ?? DEFAULT_CONFIG.maxRetries);
      const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
         try {
            const result = await client.set(this.lockKey, this.lockId, {
               NX: true,
               PX: this.ttlSeconds * 1000,
            });

            if (result === 'OK') {
               this.markAcquired();
               distributedLockAcquisitionsTotal.inc({
                  lock: this.lockName,
                  outcome: 'acquired',
               });
               logger.debug('Distributed lock acquired', {
                  lockName: this.lockName,
                  lockId: this.lockId,
                  ttlSeconds: this.ttlSeconds,
               });
               return { acquired: true, lockId: this.lockId };
            }
         } catch (error) {
            logger.warn('Error acquiring distributed lock', {
               lockName: this.lockName,
               attempt,
               error: error instanceof Error ? error.message : String(error),
            });

            if (attempt === maxRetries - 1) {
               distributedLockAcquisitionsTotal.inc({
                  lock: this.lockName,
                  outcome: 'error',
               });
               return {
                  acquired: false,
                  error: error instanceof Error ? error.message : String(error),
               };
            }
         }

         if (attempt < maxRetries - 1) {
            await delay(retryDelayMs);
         }
      }

      // Another replica holds it — the expected outcome for the non-leader.
      distributedLockAcquisitionsTotal.inc({
         lock: this.lockName,
         outcome: 'denied',
      });
      logger.debug('Distributed lock held by another instance', {
         lockName: this.lockName,
         maxRetries,
      });
      return { acquired: false };
   }

   /**
    * Redis is not reachable. Fail closed when it was configured (or explicitly
    * required); otherwise fall back to the in-process mutex so single-instance
    * deploys still run their crons.
    */
   private acquireWithoutRedis(): LockAcquisitionResult {
      const redisConfigured = Boolean(process.env.REDIS_URL?.trim());

      if (redisConfigured || isLockRequired()) {
         distributedLockAcquisitionsTotal.inc({
            lock: this.lockName,
            outcome: 'unavailable',
         });
         logger.error(
            'Distributed lock unavailable (Redis unreachable); skipping job to avoid duplicate execution',
            { lockName: this.lockName }
         );
         return { acquired: false, error: 'Redis unavailable' };
      }

      this.degraded = true;
      this.markAcquired();
      distributedLockAcquisitionsTotal.inc({
         lock: this.lockName,
         outcome: 'unlocked',
      });
      logger.warn(
         'Running scheduled job without a distributed lock (REDIS_URL not configured). ' +
            'This is only safe with a single instance — see docs/multi-instance-deployment.md',
         { lockName: this.lockName }
      );
      return { acquired: true, lockId: this.lockId, unlocked: true };
   }

   private markAcquired(): void {
      this.held = true;
      this.everAcquired = true;
      this.lost = null;
      this.acquiredAtMs = Date.now();
      this.consecutiveRenewFailures = 0;
      inProcessLocks.add(this.lockKey);
      distributedLocksHeld.inc({ lock: this.lockName });

      if (!this.degraded && this.config.autoRenew !== false) {
         this.startRenewal();
      }
   }

   private startRenewal(): void {
      this.renewTimer = setInterval(() => {
         void this.renewTick();
      }, this.renewIntervalMs);

      // Never let the heartbeat keep the process alive on shutdown.
      this.renewTimer.unref?.();
   }

   /**
    * One heartbeat: enforce the hold cap, then renew and classify the answer.
    */
   private async renewTick(): Promise<void> {
      // A slow Redis can leave a renewal in flight when the next beat fires;
      // overlapping renewals would miscount consecutive failures.
      if (this.renewing || !this.held || this.lost !== null) {
         return;
      }
      this.renewing = true;
      try {
         await this.renew();
      } finally {
         this.renewing = false;
      }
   }

   private async renew(): Promise<void> {

      if (Date.now() - this.acquiredAtMs >= this.maxHoldMs) {
         logger.error(
            'Distributed lock exceeded max hold duration; aborting job and releasing leadership',
            { lockName: this.lockName, maxHoldMs: this.maxHoldMs }
         );
         this.markLost('max_hold_exceeded');
         return;
      }

      let outcome: number;
      try {
         const client = await getConnectedRedisClient();
         if (!client) {
            throw new Error('Redis unavailable');
         }

         outcome = Number(
            await client.eval(RENEW_SCRIPT, {
               keys: [this.lockKey],
               arguments: [this.lockId, String(this.ttlSeconds * 1000)],
            })
         );
      } catch (error) {
         this.consecutiveRenewFailures += 1;
         distributedLockRenewalsTotal.inc({
            lock: this.lockName,
            outcome: 'error',
         });

         const maxFailures =
            this.config.maxRenewFailures ?? DEFAULT_MAX_RENEW_FAILURES;

         logger.warn('Failed to renew distributed lock', {
            lockName: this.lockName,
            consecutiveFailures: this.consecutiveRenewFailures,
            maxFailures,
            error: error instanceof Error ? error.message : String(error),
         });

         // Tolerate a blip, but never past the point where the TTL could have
         // lapsed and another replica taken over unnoticed.
         if (this.consecutiveRenewFailures >= maxFailures) {
            this.markLost('redis_error');
         }
         return;
      }

      if (outcome === 1) {
         this.consecutiveRenewFailures = 0;
         distributedLockRenewalsTotal.inc({
            lock: this.lockName,
            outcome: 'renewed',
         });
         return;
      }

      // Definitive "not ours" — do not retry, another leader may already be running.
      const reason: LockLostReason = outcome === -1 ? 'stolen' : 'expired';
      distributedLockRenewalsTotal.inc({
         lock: this.lockName,
         outcome: reason,
      });
      logger.error('Distributed lock is no longer held; aborting job', {
         lockName: this.lockName,
         lockId: this.lockId,
         reason,
      });
      this.markLost(reason);
   }

   /**
    * Marks the lock lost, stops the heartbeat and aborts the running job.
    *
    * The key is left to {@link release}, whose ownership-checked script deletes
    * it only if it is still ours — so a stolen key stays with its new leader
    * while a watchdog-abandoned one is freed immediately.
    */
   private markLost(reason: LockLostReason): void {
      if (this.lost !== null) return;

      this.lost = reason;
      this.held = false;
      this.stopRenewal();
      distributedLocksHeld.dec({ lock: this.lockName });
      distributedLockLostTotal.inc({ lock: this.lockName, reason });

      if (!this.abortController.signal.aborted) {
         this.abortController.abort(new LockLostError(this.lockName, reason));
      }
   }

   private stopRenewal(): void {
      if (this.renewTimer) {
         clearInterval(this.renewTimer);
         this.renewTimer = null;
      }
   }

   /** Releases the lock if still held by this instance. Safe to call twice. */
   async release(): Promise<void> {
      this.stopRenewal();

      if (this.held) {
         this.held = false;
         distributedLocksHeld.dec({ lock: this.lockName });
      }

      if (!this.everAcquired) return;

      this.everAcquired = false;
      inProcessLocks.delete(this.lockKey);
      distributedLockHeldSeconds.observe(
         { lock: this.lockName },
         (Date.now() - this.acquiredAtMs) / 1000
      );

      if (this.degraded) return;

      // Attempted even after the lock was marked lost: the release script only
      // deletes a key we still own, so this can never take the lock away from a
      // new leader, and it promptly frees a key the watchdog gave up on instead
      // of leaving every other instance blocked until the TTL lapses.
      try {
         const client = await getConnectedRedisClient();
         if (!client) return;

         await client.eval(RELEASE_SCRIPT, {
            keys: [this.lockKey],
            arguments: [this.lockId],
         });

         logger.debug('Distributed lock released', {
            lockName: this.lockName,
            lockId: this.lockId,
         });
      } catch (error) {
         // Best effort: the TTL expires the key anyway.
         logger.warn('Error releasing distributed lock', {
            lockName: this.lockName,
            error: error instanceof Error ? error.message : String(error),
         });
      }
   }

   /**
    * Verifies with Redis that we are still the leader, refreshing the TTL.
    *
    * A definitive "not ours" answer marks the lock lost (aborting the job); a
    * transient Redis error returns `false` without giving up leadership, since
    * we have no evidence anyone else took it.
    *
    * @returns `true` only when ownership was positively confirmed.
    */
   async confirmStillHeld(): Promise<boolean> {
      if (this.degraded) return this.held;
      if (!this.held || this.lost !== null) return false;

      try {
         const client = await getConnectedRedisClient();
         if (!client) return false;

         const outcome = Number(
            await client.eval(RENEW_SCRIPT, {
               keys: [this.lockKey],
               arguments: [this.lockId, String(this.ttlSeconds * 1000)],
            })
         );

         if (outcome === 1) return true;

         this.markLost(outcome === -1 ? 'stolen' : 'expired');
         return false;
      } catch (error) {
         logger.warn('Could not confirm distributed lock ownership', {
            lockName: this.lockName,
            error: error instanceof Error ? error.message : String(error),
         });
         return false;
      }
   }

   /**
    * Manually extends the TTL.
    *
    * Rarely needed — {@link acquire} starts a heartbeat automatically. Kept for
    * callers that disable `autoRenew` and drive renewal themselves.
    *
    * @returns `true` if we still own the lock and the TTL was extended.
    */
   async extend(): Promise<boolean> {
      return this.confirmStillHeld();
   }
}

/**
 * Runs `fn` as the single leader for `lockName`.
 *
 * The lock is held with a background heartbeat for as long as `fn` runs, and
 * `fn` receives a {@link LockHandle} it should poll with `assertHeld()`
 * between units of work. When `fn` returns, ownership is re-verified against
 * Redis before the result is accepted.
 *
 * @returns The function's result; `null` when the lock was not acquired (another
 *          replica owns this tick) or when the run aborted because the lock was
 *          lost. Errors thrown by `fn` other than {@link LockLostError}
 *          propagate to the caller.
 *
 * @example
 * ```typescript
 * await withDistributedLock(
 *   'oracle-resolve-rounds',
 *   async (lock) => {
 *     for (const round of rounds) {
 *       lock.assertHeld(); // stop before the next write if we lost leadership
 *       await resolve(round);
 *     }
 *   },
 *   { ttlSeconds: 45 }
 * );
 * ```
 */
export async function withDistributedLock<T>(
   lockName: string,
   fn: (lock: LockHandle) => Promise<T>,
   config: DistributedLockConfig = {}
): Promise<T | null> {
   const lock = new DistributedLock(lockName, config);

   const result = await lock.acquire();
   if (!result.acquired) {
      logger.debug('Could not acquire lock, skipping operation', { lockName });
      return null;
   }

   try {
      const value = await fn(lock.handle);

      // Re-verify with Redis rather than trusting cached state: a job that
      // finishes between two heartbeats could otherwise report a clean run
      // while another instance had already taken over mid-flight.
      const confirmed = await lock.confirmStillHeld();
      if (!confirmed) {
         const reason = lock.handle.lostReason();
         if (reason) {
            logger.error(
               'Distributed lock was lost before the job finished; its work may overlap another instance',
               { lockName, reason }
            );
         } else {
            logger.warn(
               'Could not confirm distributed lock ownership after the job finished',
               { lockName }
            );
         }
         return null;
      }

      return value;
   } catch (error) {
      if (isLockLostError(error)) {
         logger.error('Aborted job after losing distributed lock', {
            lockName,
            reason: error.reason,
         });
         return null;
      }
      throw error;
   } finally {
      await lock.release();
   }
}
