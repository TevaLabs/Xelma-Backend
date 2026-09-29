/**
 * Issue #555 — room-lock.ts unit tests.
 *
 * Verifies the Redis distributed lock used to serialize per-user room
 * mutations across multiple API instances:
 *   - Acquires and releases the lock around the callback.
 *   - Falls back to direct execution when Redis is unavailable.
 *   - Retries acquisition before falling back.
 *   - Releases the lock even if the callback throws.
 *
 * Issue #669:
 *   - Uses the *connected* shared client (getConnectedRedisClient), so the
 *     lock is not silently skipped before another module connects Redis.
 *   - Serializes callbacks for the same user in-process, with or without
 *     Redis; different users do not block each other.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Track mock implementations for the Redis client
const mockSet = jest.fn();
const mockEval = jest.fn();

jest.mock('../lib/redis', () => ({
  getConnectedRedisClient: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// Import AFTER mocks
import {
  withRoomLock,
  LOCK_TTL_MS,
  MAX_LOCK_ATTEMPTS,
  RETRY_DELAY_MS,
} from '../utils/room-lock';
import { getConnectedRedisClient } from '../lib/redis';
import logger from '../utils/logger';

const mockGetRedisClient = getConnectedRedisClient as jest.MockedFunction<typeof getConnectedRedisClient>;
const mockLogger = logger as any;

function buildMockRedis() {
  return {
    set: mockSet,
    eval: mockEval,
  };
}

describe('room-lock (Issue #555)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes callback directly when Redis is unavailable', async () => {
    mockGetRedisClient.mockResolvedValue(null);

    let called = false;
    const result = await withRoomLock('user-1', async () => {
      called = true;
      return 42;
    });

    expect(called).toBe(true);
    expect(result).toBe(42);
    // No lock operations attempted
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('acquires lock, executes callback, and releases lock on success', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);
    mockSet.mockResolvedValue('OK');
    mockEval.mockResolvedValue(1);

    const result = await withRoomLock('user-1', async () => {
      return 'done';
    });

    expect(result).toBe('done');

    // Lock acquired
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mockSet.mock.calls[0];
    expect(key).toBe('xelma:room-lock:user-1');
    expect(typeof value).toBe('string');
    expect(opts.NX).toBe(true);
    expect(opts.PX).toBe(LOCK_TTL_MS);

    // Lock released via Lua script
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockEval.mock.calls[0][0]).toContain('redis.call("get"');
  });

  it('retries acquisition before falling back', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);

    // First 9 attempts fail, 10th succeeds
    mockSet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK');
    mockEval.mockResolvedValue(1);

    const result = await withRoomLock('user-1', async () => {
      return 'acquired';
    });

    expect(result).toBe('acquired');
    expect(mockSet).toHaveBeenCalledTimes(10);
  }, 10000);

  it('falls back to direct execution after exhausting retries', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);

    // Every attempt fails. The retry budget spans the lock TTL, so a
    // waiter either gets the lock or the holder's lock has expired.
    mockSet.mockResolvedValue(null);

    let called = false;
    const result = await withRoomLock('user-1', async () => {
      called = true;
      return 'fallback';
    });

    expect(called).toBe(true);
    expect(result).toBe('fallback');
    expect(MAX_LOCK_ATTEMPTS * RETRY_DELAY_MS).toBeGreaterThanOrEqual(LOCK_TTL_MS);
    expect(mockSet).toHaveBeenCalledTimes(MAX_LOCK_ATTEMPTS);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not acquire lock'),
    );
  }, 15000);

  it('releases lock even if callback throws', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);
    mockSet.mockResolvedValue('OK');
    mockEval.mockResolvedValue(1);

    await expect(
      withRoomLock('user-1', async () => {
        throw new Error('callback error');
      }),
    ).rejects.toThrow('callback error');

    // Lock was still released
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it('uses owner-check Lua script for safe release', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);
    mockSet.mockResolvedValue('OK');
    mockEval.mockResolvedValue(1);

    await withRoomLock('user-1', async () => 'ok');

    const script = mockEval.mock.calls[0][0];
    expect(script).toContain('redis.call("get", KEYS[1])');
    expect(script).toContain('redis.call("del", KEYS[1])');

    const keys = mockEval.mock.calls[0][1].keys;
    expect(keys).toEqual(['xelma:room-lock:user-1']);
  });

  it('logs warning if lock release fails', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);
    mockSet.mockResolvedValue('OK');
    mockEval.mockRejectedValue(new Error('redis down'));

    const result = await withRoomLock('user-1', async () => 'ok');
    expect(result).toBe('ok');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release lock'),
    );
  });

  it('logs warning if lock acquisition throws', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockResolvedValue(redis as never);
    mockSet.mockRejectedValue(new Error('connection lost'));

    const result = await withRoomLock('user-1', async () => 'fallback');
    expect(result).toBe('fallback');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to acquire lock'),
    );
  }, 15000);

  it('runs the callback when fetching the Redis client throws', async () => {
    mockGetRedisClient.mockRejectedValue(new Error('redis misconfigured'));

    await expect(withRoomLock('user-1', async () => 'ok')).resolves.toBe('ok');
    expect(mockSet).not.toHaveBeenCalled();
  });

  describe('in-process serialization (Issue #669)', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>(r => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('serializes callbacks for the same user even without Redis', async () => {
      mockGetRedisClient.mockResolvedValue(null);
      const order: string[] = [];
      const gate = deferred();

      const first = withRoomLock('user-1', async () => {
        order.push('join:start');
        await gate.promise;
        order.push('join:end');
      });
      const second = withRoomLock('user-1', async () => {
        order.push('leave:start');
        order.push('leave:end');
      });

      // Let the second call reach the queue while the first is parked.
      await new Promise(r => setImmediate(r));
      expect(order).toEqual(['join:start']);

      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['join:start', 'join:end', 'leave:start', 'leave:end']);
    });

    it('keeps serializing after a callback throws', async () => {
      mockGetRedisClient.mockResolvedValue(null);
      const order: string[] = [];

      const failing = withRoomLock('user-1', async () => {
        order.push('first');
        throw new Error('boom');
      });
      const next = withRoomLock('user-1', async () => {
        order.push('second');
        return 'ok';
      });

      await expect(failing).rejects.toThrow('boom');
      await expect(next).resolves.toBe('ok');
      expect(order).toEqual(['first', 'second']);
    });

    it('does not serialize different users', async () => {
      mockGetRedisClient.mockResolvedValue(null);
      const gate = deferred();
      const order: string[] = [];

      const blocked = withRoomLock('user-1', async () => {
        await gate.promise;
        order.push('user-1');
      });
      await withRoomLock('user-2', async () => {
        order.push('user-2');
      });

      expect(order).toEqual(['user-2']);
      gate.resolve();
      await blocked;
      expect(order).toEqual(['user-2', 'user-1']);
    });
  });
});
