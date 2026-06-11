/**
 * Regression coverage for Issue #193 — dead-letter queue for failed
 * notification and websocket dispatches. Verifies the contract that
 * matters: a failure is persisted, attempts are tracked, retries flip
 * the row to RESOLVED or ABANDONED at the right boundary, and a record()
 * call that itself fails NEVER throws back into the dispatcher.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

// Typed loosely on purpose: the global `jest.fn()` returns a generic mock
// that infers `never` for `mockResolvedValue` under `strict: true`. Casting
// here keeps the existing repo style (no per-call generics) while staying
// safe under tsc --noEmit.
const mockCreate: any = jest.fn();
const mockFindUnique: any = jest.fn();
const mockFindMany: any = jest.fn();
const mockCount: any = jest.fn();
const mockUpdate: any = jest.fn();
const mockDeleteMany: any = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    failedDispatch: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      findMany: (...args: any[]) => mockFindMany(...args),
      count: (...args: any[]) => mockCount(...args),
      update: (...args: any[]) => mockUpdate(...args),
      deleteMany: (...args: any[]) => mockDeleteMany(...args),
    },
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Stand-in enum values so the test does not require the generated Prisma
// client to be available in CI before `prisma generate` runs.
jest.mock('@prisma/client', () => ({
  DispatchChannel: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
  DispatchStatus: {
    PENDING: 'PENDING',
    RETRYING: 'RETRYING',
    RESOLVED: 'RESOLVED',
    ABANDONED: 'ABANDONED',
  },
  Prisma: {},
}));

import deadLetterQueueService from '../services/dead-letter-queue.service';
import { DispatchChannel, DispatchStatus } from '@prisma/client';

describe('DeadLetterQueueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('record', () => {
    it('persists a failure with truncated error and PENDING status', async () => {
      mockCreate.mockResolvedValue({ id: 'dlq-1' });
      const longErr = new Error('x'.repeat(2_500));

      const result = await deadLetterQueueService.record({
        channel: DispatchChannel.NOTIFICATION_CREATE,
        eventName: 'WIN',
        userId: 'user-1',
        payload: { foo: 'bar' },
        error: longErr,
      });

      expect(result).toEqual({ id: 'dlq-1' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const args: any = mockCreate.mock.calls[0][0];
      expect(args.data.channel).toBe('NOTIFICATION_CREATE');
      expect(args.data.eventName).toBe('WIN');
      expect(args.data.userId).toBe('user-1');
      expect(args.data.attempts).toBe(1);
      expect(args.data.status).toBe('PENDING');
      expect(args.data.lastError.length).toBeLessThanOrEqual(1000);
    });

    it('swallows DB errors and returns null so the caller is never crashed by the DLQ', async () => {
      mockCreate.mockRejectedValue(new Error('db down'));

      const result = await deadLetterQueueService.record({
        channel: DispatchChannel.WEBSOCKET_EMIT,
        eventName: 'notification:new',
        payload: {},
        error: new Error('original'),
      });

      expect(result).toBeNull();
    });

    it('serializes non-Error errors safely', async () => {
      mockCreate.mockResolvedValue({ id: 'dlq-2' });
      await deadLetterQueueService.record({
        channel: DispatchChannel.WEBSOCKET_EMIT,
        payload: {},
        error: { code: 42, msg: 'something broke' },
      });
      const args: any = mockCreate.mock.calls[0][0];
      expect(typeof args.data.lastError).toBe('string');
      expect(args.data.lastError).toContain('42');
    });
  });

  describe('retry', () => {
    const handlers = {
      notificationCreate: jest.fn(),
      websocketEmit: jest.fn(),
    } as any;

    beforeEach(() => {
      handlers.notificationCreate.mockReset();
      handlers.websocketEmit.mockReset();
    });

    it('returns null for an unknown id', async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await deadLetterQueueService.retry('nope', handlers);
      expect(result).toBeNull();
      expect(handlers.notificationCreate).not.toHaveBeenCalled();
    });

    it('is idempotent on a RESOLVED row', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'r1',
        status: 'RESOLVED',
        channel: 'NOTIFICATION_CREATE',
        attempts: 2,
        payload: {},
      });
      const result = await deadLetterQueueService.retry('r1', handlers);
      expect(result).toEqual({ id: 'r1', status: 'RESOLVED', attempts: 2 });
      expect(handlers.notificationCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('marks RESOLVED when the handler succeeds', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'r2',
        status: 'PENDING',
        channel: 'NOTIFICATION_CREATE',
        attempts: 1,
        payload: { userId: 'u1', type: 'WIN', title: 't', message: 'm' },
        eventName: 'WIN',
        userId: 'u1',
      });
      handlers.notificationCreate.mockResolvedValue({ id: 'notif-x' });
      mockUpdate.mockResolvedValue({ id: 'r2', status: 'RESOLVED', attempts: 2 });

      const result = await deadLetterQueueService.retry('r2', handlers);

      expect(handlers.notificationCreate).toHaveBeenCalledWith({
        userId: 'u1',
        type: 'WIN',
        title: 't',
        message: 'm',
      });
      expect(result?.status).toBe('RESOLVED');
      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('RESOLVED');
      expect(updateArgs.data.resolvedAt).toBeInstanceOf(Date);
    });

    it('bumps attempts to RETRYING below the cap when the handler fails', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'r3',
        status: 'PENDING',
        channel: 'WEBSOCKET_EMIT',
        attempts: 1,
        payload: { room: 'user:u1', data: {} },
        eventName: 'notification:new',
        userId: 'u1',
      });
      handlers.websocketEmit.mockImplementation(() => {
        throw new Error('socket still down');
      });
      mockUpdate.mockResolvedValue({ id: 'r3', status: 'RETRYING', attempts: 2 });

      const result = await deadLetterQueueService.retry('r3', handlers, 5);

      expect(result?.status).toBe('RETRYING');
      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('RETRYING');
      expect(updateArgs.data.attempts).toBe(2);
      expect(updateArgs.data.lastError).toContain('socket still down');
    });

    it('marks ABANDONED once attempts reach the cap', async () => {
      mockFindUnique.mockResolvedValue({
        id: 'r4',
        status: 'RETRYING',
        channel: 'WEBSOCKET_EMIT',
        attempts: 4, // next attempt -> 5, hits cap of 5
        payload: { room: 'user:u1', data: {} },
        eventName: 'notification:new',
        userId: 'u1',
      });
      handlers.websocketEmit.mockImplementation(() => {
        throw new Error('still failing');
      });
      mockUpdate.mockResolvedValue({ id: 'r4', status: 'ABANDONED', attempts: 5 });

      const result = await deadLetterQueueService.retry('r4', handlers, 5);

      expect(result?.status).toBe('ABANDONED');
      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('ABANDONED');
      expect(updateArgs.data.attempts).toBe(5);
    });
  });

  describe('retryAll', () => {
    it('returns a counts summary across mixed outcomes', async () => {
      const handlers = {
        notificationCreate: jest.fn(),
        websocketEmit: jest.fn(),
      } as any;
      mockFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      // First retry call: success
      mockFindUnique
        .mockResolvedValueOnce({
          id: 'a',
          status: 'PENDING',
          channel: 'NOTIFICATION_CREATE',
          attempts: 1,
          payload: {},
        })
        .mockResolvedValueOnce({
          id: 'b',
          status: 'RETRYING',
          channel: 'NOTIFICATION_CREATE',
          attempts: 4,
          payload: {},
        });
      handlers.notificationCreate
        .mockResolvedValueOnce({ id: 'notif' })
        .mockRejectedValueOnce(new Error('boom'));
      mockUpdate
        .mockResolvedValueOnce({ id: 'a', status: 'RESOLVED', attempts: 2 })
        .mockResolvedValueOnce({ id: 'b', status: 'ABANDONED', attempts: 5 });

      const result = await deadLetterQueueService.retryAll(handlers, 50, 5);

      expect(result).toEqual({
        attempted: 2,
        resolved: 1,
        failed: 1,
        abandoned: 1,
      });
    });
  });

  describe('list', () => {
    it('clamps limit to the [1, 200] range', async () => {
      mockFindMany.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);

      await deadLetterQueueService.list({ limit: 9999 });
      expect(mockFindMany.mock.calls[0][0].take).toBe(200);

      await deadLetterQueueService.list({ limit: -3 });
      expect(mockFindMany.mock.calls[1][0].take).toBe(1);
    });
  });

  describe('cleanupResolved', () => {
    it('only deletes RESOLVED rows older than the cutoff', async () => {
      mockDeleteMany.mockResolvedValue({ count: 7 });
      const count = await deadLetterQueueService.cleanupResolved(3);
      expect(count).toBe(7);
      const args: any = mockDeleteMany.mock.calls[0][0];
      expect(args.where.status).toBe('RESOLVED');
      expect(args.where.resolvedAt.lt).toBeInstanceOf(Date);
    });
  });
});
