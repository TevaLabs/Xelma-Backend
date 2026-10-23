/**
 * Per-wallet claim lock (Double-Claim Risk fix).
 *
 * Eliminates the TOCTOU race in BetService.claimWinnings() where two
 * concurrent requests for the same wallet address could both pass the
 * "no open claim" check and both submit on-chain, resulting in double
 * crediting.
 *
 * ## Strategy
 *
 * ### PostgreSQL (production / DATA_STORE=postgres)
 * Uses `pg_try_advisory_xact_lock(bigint)` inside a `$transaction` callback.
 * The advisory lock is session-scoped to the transaction: it is automatically
 * released when the transaction commits or rolls back, so no manual cleanup
 * is required even if the caller throws.
 *
 * The lock key is derived from a stable hash of the wallet address, mapped to
 * the int64 range Postgres requires for advisory locks.
 *
 * If the lock cannot be acquired (another connection already holds it for this
 * wallet), we poll briefly — identical behaviour to what callers already rely
 * on for the idempotency lock — then give up with a ConflictError so the
 * client knows to retry.
 *
 * ### In-memory (DATA_STORE=memory / BET_STUB_MODE)
 * A plain in-process `Map<address, Promise>` mutex serialises concurrent
 * claim calls within the same Node.js process. This is sufficient for tests
 * and single-node development; it does NOT protect across multiple replicas
 * (the distributed idempotency lock at the route layer already handles that).
 */

import { prisma } from '../lib/prisma';
import logger from './logger';
import { ConflictError, ErrorCode } from './errors';

// ---------------------------------------------------------------------------
// In-memory mutex (used when DATA_STORE=memory or BET_STUB_MODE=true)
// ---------------------------------------------------------------------------

/**
 * Active in-memory claim locks keyed by wallet address.
 * Each value is a promise that resolves when the current lock holder finishes.
 */
const inMemoryLocks = new Map<string, Promise<void>>();

/** Acquire the in-memory mutex for `address` and run `fn` inside it. */
async function withInMemoryClaimLock<T>(
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Chain onto the existing tail so callers queue up sequentially.
  const tail = inMemoryLocks.get(address) ?? Promise.resolve();

  let releaseLock!: () => void;
  // This promise represents the current holder's slot; it resolves when we
  // call releaseLock() in the finally block.
  const slot = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  // The new tail is: wait for the previous tail, then wait for our slot.
  // Any subsequent caller will chain behind our slot.
  inMemoryLocks.set(address, tail.then(() => slot));

  // Wait until the previous holder has released, then we own the lock.
  await tail;
  try {
    return await fn();
  } finally {
    releaseLock();
    // If no other caller has chained behind us, clean up the map entry so
    // the Map doesn't hold a reference to resolved promises indefinitely.
    // We compare against the promise we registered; if it has been replaced
    // by a later chained entry we leave it alone.
    if (inMemoryLocks.get(address) === tail.then(() => slot)) {
      inMemoryLocks.delete(address);
    }
  }
}

/** Test helper: clear all in-memory claim lock state between test runs. */
export function resetInMemoryClaimLocks(): void {
  inMemoryLocks.clear();
}

// ---------------------------------------------------------------------------
// Advisory-lock key derivation
// ---------------------------------------------------------------------------

/**
 * Map a wallet address string to a stable int64 advisory-lock key.
 *
 * We hash the address with a simple djb2-style algorithm then fold it into
 * the signed 32-bit range that `pg_try_advisory_xact_lock` accepts as its
 * single int4 argument.  Using int4 (rather than two int4 args) is simpler
 * and still gives us 2^32 distinct lock buckets — far more than the number
 * of concurrent wallet addresses we'll ever see.
 *
 * Note: collisions are harmless — two wallets that map to the same key will
 * serialise against each other, which is slightly pessimistic but never
 * incorrect.
 */
function addressToLockKey(address: string): number {
  let h = 5381;
  for (let i = 0; i < address.length; i++) {
    h = ((h << 5) + h + address.charCodeAt(i)) | 0; // keep in int32 range
  }
  // Postgres advisory lock keys are signed int4; keep within [-2^31, 2^31-1].
  return h | 0;
}

// ---------------------------------------------------------------------------
// PostgreSQL advisory lock
// ---------------------------------------------------------------------------

const ACQUIRE_TIMEOUT_MS = 10_000;
const ACQUIRE_RETRY_MS = 50;

/**
 * Acquire a PostgreSQL advisory transaction lock for the given wallet address,
 * run `fn` inside the transaction that holds the lock, then commit.
 *
 * If the lock cannot be acquired within `ACQUIRE_TIMEOUT_MS` ms, throws a
 * `ConflictError` (HTTP 409) so the client can retry.
 */
async function withPostgresClaimLock<T>(
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = addressToLockKey(address);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let acquired = false;
    let fnResult: T | undefined;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.$transaction(async (tx: any) => {
        // pg_try_advisory_xact_lock returns true if the lock was acquired,
        // false if another session already holds it.
        const rows = await tx.$queryRaw<[{ acquired: boolean }]>`
          SELECT pg_try_advisory_xact_lock(${lockKey}::int4) AS acquired
        `;
        acquired = rows[0]?.acquired ?? false;

        if (!acquired) {
          // Roll back the transaction immediately so we don't hold an idle
          // connection while we wait to retry.
          throw new _LockBusy();
        }

        logger.debug('[claim-lock] advisory lock acquired', {
          address,
          lockKey,
        });

        fnResult = await fn();
        // Transaction commits here → advisory lock is released automatically.
      });

      // If we reach this point without throwing, `fn` ran successfully.
      return fnResult as T;
    } catch (err) {
      if (err instanceof _LockBusy) {
        // Another session holds the lock — wait and retry.
        await new Promise((resolve) => setTimeout(resolve, ACQUIRE_RETRY_MS));
        continue;
      }
      // Real error from `fn` or Prisma — propagate immediately.
      throw err;
    }
  }

  // Deadline elapsed while lock was held by another session.
  logger.warn('[claim-lock] could not acquire advisory lock before timeout', {
    address,
    lockKey,
    timeoutMs: ACQUIRE_TIMEOUT_MS,
  });
  throw new ConflictError(
    'Another claim request for this wallet is already in progress. Please retry.',
    ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
  );
}

/** Sentinel thrown only to roll back the Prisma transaction on lock-busy. */
class _LockBusy extends Error {
  constructor() {
    super('lock-busy');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs `fn` while holding a per-wallet mutex that prevents concurrent claim
 * submissions for the same wallet address.
 *
 * - **PostgreSQL mode** (`DATA_STORE=postgres`): uses a PostgreSQL advisory
 *   transaction lock so the mutual exclusion extends across all API replicas
 *   and the background reconciliation worker.
 * - **Memory mode** (`DATA_STORE=memory` / `BET_STUB_MODE=true`): uses an
 *   in-process async mutex for the single-node case.
 */
export async function withClaimLock<T>(
  address: string,
  fn: () => Promise<T>,
): Promise<T> {
  const isMemory =
    process.env.DATA_STORE === 'memory' ||
    process.env.BET_STUB_MODE === 'true';

  if (isMemory) {
    return withInMemoryClaimLock(address, fn);
  }

  return withPostgresClaimLock(address, fn);
}
