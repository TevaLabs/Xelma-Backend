/**
 * Unit tests for the transactional outbox processor (Issue #18).
 *
 * Verifies the core contract:
 *   - PENDING rows are claimed, dispatched, and marked PROCESSED on success.
 *   - Failed dispatches increment `attempts` and reset to PENDING for retry.
 *   - Once `maxAttempts` is exhausted the row is marked FAILED and escalated
 *     to the DLQ so an operator can replay it.
 *   - `cleanupProcessed` only deletes PROCESSED rows older than the cutoff.
 *   - The poller skips rows that were already claimed by another instance
 *     (updateMany returns count=0).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

// ─── mock prisma ─────────────────────────────────────────────────────────────

const mockFindMany: any = jest.fn();
const mockUpdateMany: any = jest.fn();
const mockUpdate: any = jest.fn();
const mockDeleteMany: any = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    outboxEvent: {
      findMany: (...args: any[]) => mockFindMany(...args),
      updateMany: (...args: any[]) => mockUpdateMany(...args),
      update: (...args: any[]) => mockUpdate(...args),
      deleteMany: (...args: any[]) => mockDeleteMany(...args),
    },
  },
}));

// ─── mock DLQ ────────────────────────────────────────────────────────────────

const mockDlqRecord: any = jest.fn();

jest.mock('../services/dead-letter-queue.service', () => ({
  __esModule: true,
  default: { record: (...args: any[]) => mockDlqRecord(...args) },
}));

// ─── mock logger ─────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ─── mock Prisma enums ───────────────────────────────────────────────────────

jest.mock('@prisma/client', () => ({
  OutboxEventStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
  },
  OutboxEventType: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
  DispatchChannel: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
}));

import outboxService from '../services/outbox.service';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<any> = {}): any {
  return {
    id: 'evt-1',
    eventType: 'NOTIFICATION_CREATE',
    aggregateId: 'round-1',
    aggregateType: 'round',
    payload: {
      userId: 'user-1',
      type: 'WIN',
      title: 'You Won!',
      message: 'Congrats',
      data: { roundId: 'round-1', amount: 150 },
    },
    status: 'PENDING',
    attempts: 0,
    ...overrides,
  };
}

function makeHandlers(overrides: Partial<any> = {}): any {
  return {
    notificationCreate: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    websocketEmit: jest.fn(),
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('OutboxService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDlqRecord.mockResolvedValue({ id: 'dlq-1' });
  });

  describe('processOutbox', () => {
    it('returns zero counts when there are no pending rows', async () => {
      mockFindMany.mockResolvedValue([]);

      const result = await outboxService.processOutbox(makeHandlers());

      expect(result).toEqual({ processed: 0, failed: 0, escalated: 0 });
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('claims, dispatches, and marks PROCESSED on success', async () => {
      const row = makeRow();
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 }); // claim succeeds
      mockUpdate.mockResolvedValue({ ...row, status: 'PROCESSED' });

      const handlers = makeHandlers();
      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result).toEqual({ processed: 1, failed: 0, escalated: 0 });

      // Claim step
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'PROCESSING', updatedAt: expect.any(Date) },
      });

      // Handler called with payload
      expect(handlers.notificationCreate).toHaveBeenCalledWith(row.payload);

      // Mark PROCESSED
      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('PROCESSED');
      expect(updateArgs.data.processedAt).toBeInstanceOf(Date);
    });

    it('dispatches WEBSOCKET_EMIT rows via the websocketEmit handler', async () => {
      const row = makeRow({
        eventType: 'WEBSOCKET_EMIT',
        payload: {
          eventName: 'notification:new',
          room: 'user:user-1',
          userId: 'user-1',
          data: { type: 'WIN' },
        },
      });
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdate.mockResolvedValue({ ...row, status: 'PROCESSED' });

      const handlers = makeHandlers();
      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result.processed).toBe(1);
      expect(handlers.websocketEmit).toHaveBeenCalledWith(row.payload);
      expect(handlers.notificationCreate).not.toHaveBeenCalled();
    });

    it('skips a row when the claim races (updateMany returns count=0)', async () => {
      const row = makeRow();
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 0 }); // another instance claimed it

      const handlers = makeHandlers();
      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result).toEqual({ processed: 0, failed: 0, escalated: 0 });
      expect(handlers.notificationCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('increments attempts and resets to PENDING on dispatch failure below cap', async () => {
      const row = makeRow({ attempts: 1 });
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdate.mockResolvedValue({ ...row, status: 'PENDING', attempts: 2 });

      const handlers = makeHandlers({
        notificationCreate: jest.fn().mockRejectedValue(new Error('db down')),
      });

      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result).toEqual({ processed: 0, failed: 1, escalated: 0 });

      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('PENDING');
      expect(updateArgs.data.attempts).toBe(2);
      expect(typeof updateArgs.data.lastError).toBe('string');
      expect(updateArgs.data.lastError).toContain('db down');

      // DLQ not called yet — not exhausted
      expect(mockDlqRecord).not.toHaveBeenCalled();
    });

    it('marks FAILED and escalates to DLQ when maxAttempts is reached', async () => {
      const row = makeRow({ attempts: 2 }); // next attempt = 3 = cap
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdate.mockResolvedValue({ ...row, status: 'FAILED', attempts: 3 });

      const handlers = makeHandlers({
        notificationCreate: jest.fn().mockRejectedValue(new Error('still down')),
      });

      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result).toEqual({ processed: 0, failed: 1, escalated: 1 });

      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('FAILED');
      expect(updateArgs.data.attempts).toBe(3);

      // DLQ escalation
      expect(mockDlqRecord).toHaveBeenCalledTimes(1);
      const dlqArgs: any = mockDlqRecord.mock.calls[0][0];
      expect(dlqArgs.channel).toBe('NOTIFICATION_CREATE');
      expect(dlqArgs.payload).toEqual(row.payload);
    });

    it('escalates WEBSOCKET_EMIT failures to DLQ with correct channel', async () => {
      const row = makeRow({
        eventType: 'WEBSOCKET_EMIT',
        attempts: 2,
        payload: { eventName: 'round:resolved', room: 'round', data: {} },
      });
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdate.mockResolvedValue({ ...row, status: 'FAILED', attempts: 3 });

      const handlers = makeHandlers({
        websocketEmit: jest.fn().mockImplementation(() => {
          throw new Error('socket crash');
        }),
      });

      await outboxService.processOutbox(handlers, 50, 3);

      const dlqArgs: any = mockDlqRecord.mock.calls[0][0];
      expect(dlqArgs.channel).toBe('WEBSOCKET_EMIT');
    });

    it('processes multiple rows and returns correct aggregate counts', async () => {
      const rows = [
        makeRow({ id: 'evt-a', attempts: 0 }),
        makeRow({ id: 'evt-b', attempts: 2 }), // will be exhausted
        makeRow({ id: 'evt-c', attempts: 0 }),
      ];
      mockFindMany.mockResolvedValue(rows);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      const handlers = makeHandlers({
        notificationCreate: jest
          .fn()
          .mockResolvedValueOnce({ id: 'n1' })   // evt-a: success
          .mockRejectedValueOnce(new Error('x'))  // evt-b: fail → exhausted
          .mockResolvedValueOnce({ id: 'n3' }),   // evt-c: success
      });

      mockUpdate
        .mockResolvedValueOnce({ id: 'evt-a', status: 'PROCESSED', attempts: 1 })
        .mockResolvedValueOnce({ id: 'evt-b', status: 'FAILED', attempts: 3 })
        .mockResolvedValueOnce({ id: 'evt-c', status: 'PROCESSED', attempts: 1 });

      const result = await outboxService.processOutbox(handlers, 50, 3);

      expect(result).toEqual({ processed: 2, failed: 1, escalated: 1 });
    });

    it('truncates long error messages to 1000 chars', async () => {
      const row = makeRow({ attempts: 0 });
      mockFindMany.mockResolvedValue([row]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockUpdate.mockResolvedValue({ ...row, status: 'PENDING', attempts: 1 });

      const longError = new Error('x'.repeat(3000));
      const handlers = makeHandlers({
        notificationCreate: jest.fn().mockRejectedValue(longError),
      });

      await outboxService.processOutbox(handlers, 50, 3);

      const updateArgs: any = mockUpdate.mock.calls[0][0];
      expect(updateArgs.data.lastError.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('cleanupProcessed', () => {
    it('deletes only PROCESSED rows older than the cutoff', async () => {
      mockDeleteMany.mockResolvedValue({ count: 12 });

      const count = await outboxService.cleanupProcessed(7);

      expect(count).toBe(12);
      const args: any = mockDeleteMany.mock.calls[0][0];
      expect(args.where.status).toBe('PROCESSED');
      expect(args.where.processedAt.lt).toBeInstanceOf(Date);
    });

    it('returns 0 when nothing is deleted', async () => {
      mockDeleteMany.mockResolvedValue({ count: 0 });
      const count = await outboxService.cleanupProcessed(7);
      expect(count).toBe(0);
    });
  });
});
