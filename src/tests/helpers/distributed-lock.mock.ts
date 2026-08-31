import type { LockHandle } from '../../utils/distributed-lock';

/**
 * A {@link LockHandle} that always reports leadership.
 *
 * Service specs exercise job logic, not leader election, so they run the
 * protected function directly with this handle. Tests that care about lock
 * loss should use {@link lostLockHandle} or the real lock instead — see
 * `distributed-lock-multiworker.spec.ts`.
 */
export function heldLockHandle(lockName = 'test-lock'): LockHandle {
   return {
      lockName,
      lockId: 'test-lock-id',
      signal: new AbortController().signal,
      isHeld: () => true,
      lostReason: () => null,
      assertHeld: () => {},
   };
}

/**
 * Module factory for `jest.mock('../utils/distributed-lock', ...)`.
 *
 * Keeps the module's real exports (notably `isLockLostError`, which the
 * schedulers use to classify aborts) and replaces only `withDistributedLock`
 * with a pass-through that always runs the job as leader.
 *
 * @example
 * ```typescript
 * jest.mock('../utils/distributed-lock', () =>
 *    require('./helpers/distributed-lock.mock').passThroughLockModule()
 * );
 * ```
 */
export function passThroughLockModule(): Record<string, unknown> {
   const actual = jest.requireActual(
      '../../utils/distributed-lock'
   ) as typeof import('../../utils/distributed-lock');

   return {
      ...actual,
      withDistributedLock: jest.fn(
         async (
            lockName: string,
            fn: (lock: LockHandle) => Promise<unknown>
         ) => fn(heldLockHandle(lockName))
      ),
   };
}
