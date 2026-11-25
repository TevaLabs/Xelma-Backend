/**
 * Issue #1006 — a DLQ row must never be dispatched twice for one failure,
 * even when replays overlap or the post-emit DB write fails.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

const mockFindUnique: any = jest.fn();
const mockUpdate: any = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    failedDispatch: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

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

import deadLetterQueueService, {
  resetDispatchDedupe,
} from '../services/dead-letter-queue.service';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq-1',
    channel: 'WEBSOCKET_EMIT',
    eventName: 'notification:new',
    userId: 'u1',
    payload: { room: 'user:u1', data: { id: 'x' } },
    attempts: 1,
    status: 'PENDING',
    ...overrides,
  };
}

function handlers() {
  return {
    notificationCreate: jest.fn(async () => undefined) as any,
    websocketEmit: jest.fn(async () => undefined) as any,
  };
}

describe('DLQ replay idempotency (Issue #1006)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDispatchDedupe();
    mockFindUnique.mockResolvedValue(row());
    mockUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'dlq-1',
      status: data.status,
      attempts: 2,
    }));
  });

  it('passes the stable dispatch id to the handler', async () => {
    const h = handlers();
    await deadLetterQueueService.retry('dlq-1', h);
    expect(h.websocketEmit).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'dlq-1' }),
    );
  });

  it('emits once when the same row is replayed concurrently', async () => {
    let release!: () => void;
    const h = handlers();
    h.websocketEmit.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const first = deadLetterQueueService.retry('dlq-1', h);
    await new Promise((r) => setImmediate(r));
    const second = await deadLetterQueueService.retry('dlq-1', h);
    release();
    await first;

    expect(h.websocketEmit).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ id: 'dlq-1', status: 'PENDING', attempts: 1 });
  });

  it('does not emit again when the emit succeeded but marking RESOLVED failed', async () => {
    const h = handlers();
    mockUpdate.mockRejectedValueOnce(new Error('db blip'));

    const first: any = await deadLetterQueueService.retry('dlq-1', h);
    expect(first.status).toBe('PENDING');
    expect(h.websocketEmit).toHaveBeenCalledTimes(1);

    const second: any = await deadLetterQueueService.retry('dlq-1', h);
    expect(h.websocketEmit).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('RESOLVED');
  });

  it('still retries (and counts an attempt) when the handler itself fails', async () => {
    const h = handlers();
    h.websocketEmit.mockRejectedValueOnce(new Error('socket down'));

    const first: any = await deadLetterQueueService.retry('dlq-1', h);
    expect(first.status).toBe('RETRYING');

    const second: any = await deadLetterQueueService.retry('dlq-1', h);
    expect(h.websocketEmit).toHaveBeenCalledTimes(2);
    expect(second.status).toBe('RESOLVED');
  });

  it('applies the same guard to notification replays', async () => {
    mockFindUnique.mockResolvedValue(row({ channel: 'NOTIFICATION_CREATE' }));
    const h = handlers();
    mockUpdate.mockRejectedValueOnce(new Error('db blip'));

    await deadLetterQueueService.retry('dlq-1', h);
    await deadLetterQueueService.retry('dlq-1', h);

    expect(h.notificationCreate).toHaveBeenCalledTimes(1);
    expect(h.notificationCreate).toHaveBeenCalledWith(expect.anything(), 'dlq-1');
  });
});
