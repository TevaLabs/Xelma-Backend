/**
 * Issue #555 — room-lock.ts unit tests.
 *
 * Verifies the Redis distributed lock used to serialize per-user room
 * mutations across multiple API instances:
 *   - Acquires and releases the lock around the callback.
 *   - Falls back to direct execution when Redis is unavailable.
 *   - Retries acquisition before falling back.
 *   - Releases the lock even if the callback throws.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Track mock implementations for the Redis client
const mockSet = jest.fn();
const mockEval = jest.fn();

jest.mock('../lib/redis', () => ({
  getRedisClient: jest.fn(),
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
import { withRoomLock, LOCK_TTL_MS } from '../utils/room-lock';
import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

const mockGetRedisClient = getRedisClient as jest.MockedFunction<typeof getRedisClient>;
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
    mockGetRedisClient.mockReturnValue(null);

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
    mockGetRedisClient.mockReturnValue(redis);
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
    mockGetRedisClient.mockReturnValue(redis);

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
    mockGetRedisClient.mockReturnValue(redis);

    // All 10 attempts fail
    for (let i = 0; i < 10; i++) {
      mockSet.mockResolvedValueOnce(null);
    }

    let called = false;
    const result = await withRoomLock('user-1', async () => {
      called = true;
      return 'fallback';
    });

    expect(called).toBe(true);
    expect(result).toBe('fallback');
    expect(mockSet).toHaveBeenCalledTimes(10);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not acquire lock'),
    );
  }, 10000);

  it('releases lock even if callback throws', async () => {
    const redis = buildMockRedis();
    mockGetRedisClient.mockReturnValue(redis);
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
    mockGetRedisClient.mockReturnValue(redis);
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
    mockGetRedisClient.mockReturnValue(redis);
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
    mockGetRedisClient.mockReturnValue(redis);
    mockSet.mockRejectedValue(new Error('connection lost'));

    const result = await withRoomLock('user-1', async () => 'fallback');
    expect(result).toBe('fallback');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to acquire lock'),
    );
  });
});
