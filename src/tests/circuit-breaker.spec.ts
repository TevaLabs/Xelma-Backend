import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import logger from '../utils/logger';
import { CircuitBreaker, CircuitBreakerOpenError } from '../utils/circuit-breaker';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('CircuitBreaker', () => {
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-04-29T12:00:00.000Z');
    jest.clearAllMocks();
  });

  function createBreaker(): CircuitBreaker {
    return new CircuitBreaker({
      name: 'test-upstream',
      failureThreshold: 2,
      openBackoffMs: 1_000,
      halfOpenMaxCalls: 1,
      now: () => now,
    });
  }

  it('starts closed and allows successful calls', async () => {
    const breaker = createBreaker();

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');

    expect(breaker.getSnapshot()).toMatchObject({
      state: 'closed',
      failureCount: 0,
      halfOpenInFlight: 0,
    });
  });

  it('opens after the failure threshold and short-circuits calls', async () => {
    const breaker = createBreaker();
    const operation = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'));

    await expect(breaker.execute(operation)).rejects.toThrow('first failure');
    await expect(breaker.execute(operation)).rejects.toThrow('second failure');

    const snapshot = breaker.getSnapshot();
    expect(snapshot.state).toBe('open');
    expect(snapshot.nextAttemptAt?.toISOString()).toBe('2026-04-29T12:00:01.000Z');

    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('logs state transitions with reason and timestamp', async () => {
    const breaker = createBreaker();

    await expect(breaker.execute(async () => {
      throw new Error('upstream down');
    })).rejects.toThrow('upstream down');
    await expect(breaker.execute(async () => {
      throw new Error('still down');
    })).rejects.toThrow('still down');

    expect(logger.warn).toHaveBeenCalledWith('Circuit breaker state changed', expect.objectContaining({
      breaker: 'test-upstream',
      previousState: 'closed',
      state: 'open',
      reason: 'failure_threshold_reached',
      timestamp: '2026-04-29T12:00:00.000Z',
      nextAttemptAt: '2026-04-29T12:00:01.000Z',
      error: 'still down',
    }));
  });

  it('moves to half-open after cooldown and closes after a successful probe', async () => {
    const breaker = createBreaker();

    await expect(breaker.execute(async () => {
      throw new Error('one');
    })).rejects.toThrow('one');
    await expect(breaker.execute(async () => {
      throw new Error('two');
    })).rejects.toThrow('two');

    now += 1_000;
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');

    expect(breaker.getSnapshot()).toMatchObject({
      state: 'closed',
      failureCount: 0,
      halfOpenInFlight: 0,
    });
    expect(logger.warn).toHaveBeenCalledWith('Circuit breaker state changed', expect.objectContaining({
      previousState: 'open',
      state: 'half-open',
      reason: 'cooldown_elapsed',
    }));
    expect(logger.warn).toHaveBeenCalledWith('Circuit breaker state changed', expect.objectContaining({
      previousState: 'half-open',
      state: 'closed',
      reason: 'half_open_probe_succeeded',
    }));
  });

  it('reopens when the half-open probe fails', async () => {
    const breaker = createBreaker();

    await expect(breaker.execute(async () => {
      throw new Error('one');
    })).rejects.toThrow('one');
    await expect(breaker.execute(async () => {
      throw new Error('two');
    })).rejects.toThrow('two');

    now += 1_000;
    await expect(breaker.execute(async () => {
      throw new Error('probe failed');
    })).rejects.toThrow('probe failed');

    expect(breaker.getSnapshot().state).toBe('open');
    expect(logger.warn).toHaveBeenCalledWith('Circuit breaker state changed', expect.objectContaining({
      previousState: 'half-open',
      state: 'open',
      reason: 'half_open_probe_failed',
      error: 'probe failed',
    }));
  });
});
