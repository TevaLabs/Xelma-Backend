/**
 * Regression coverage for Issue #193 — websocket emit failures route into
 * the DLQ instead of disappearing into a log line. Two cases matter most:
 *
 *   1. The socket layer was never initialized (process started API-only,
 *      or socket init crashed). Old behavior: warn + drop. New behavior:
 *      DLQ row recorded so the event can be replayed once sockets are up.
 *   2. The underlying `io.to(room).emit(...)` throws. Old behavior:
 *      uncaught and could break a hot path (e.g. round resolution).
 *      New behavior: caught + DLQ row recorded.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

const mockRecord: any = jest.fn();

jest.mock('../services/dead-letter-queue.service', () => ({
  __esModule: true,
  default: { record: (...args: any[]) => mockRecord(...args) },
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

jest.mock('@prisma/client', () => ({
  DispatchChannel: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
}));

import websocketService from '../services/websocket.service';

describe('WebSocketService DLQ wiring (#193)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Force the singleton back to an uninitialized state between tests.
    (websocketService as any).io = null;
  });

  it('records a DLQ entry when emitNotification fires before init', () => {
    websocketService.emitNotification('user-1', {
      id: 'n1',
      type: 'WIN',
      title: 't',
      message: 'm',
      data: null,
      isRead: false,
      createdAt: new Date('2026-05-30T00:00:00Z'),
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const args: any = mockRecord.mock.calls[0][0];
    expect(args.channel).toBe('WEBSOCKET_EMIT');
    expect(args.eventName).toBe('notification:new');
    expect(args.userId).toBe('user-1');
    expect(args.payload.room).toBe('user:user-1');
    expect(args.payload.data.id).toBe('n1');
  });

  it('records a DLQ entry when emitChatMessage fires before init', () => {
    websocketService.emitChatMessage({ id: 'm1', content: 'hi' });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].eventName).toBe('chat:message');
    expect(mockRecord.mock.calls[0][0].userId).toBeNull();
  });

  it('records a DLQ entry when the underlying emit throws', () => {
    const emit = jest.fn(() => {
      throw new Error('socket crash');
    });
    const fakeIo = { to: jest.fn(() => ({ emit })) } as any;
    websocketService.initialize(fakeIo);

    websocketService.emitRoundStarted({
      id: 'r1',
      mode: 'UP_DOWN',
      status: 'ACTIVE',
      startTime: new Date(),
      endTime: new Date(),
      startPrice: '1.00',
      priceRanges: null,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const args: any = mockRecord.mock.calls[0][0];
    expect(args.channel).toBe('WEBSOCKET_EMIT');
    expect(args.eventName).toBe('round:started');
    expect(args.payload.room).toBe('round');
    expect(args.error).toBeInstanceOf(Error);
  });

  it('does not record when emit succeeds', () => {
    const emit = jest.fn();
    const fakeIo = { to: jest.fn(() => ({ emit })) } as any;
    websocketService.initialize(fakeIo);

    websocketService.emitPriceUpdate('XLM', '0.42');

    expect(emit).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('replayEmit throws if sockets are not initialized so DLQ retry bumps attempts', () => {
    (websocketService as any).io = null;
    expect(() => websocketService.replayEmit('notification:new', { room: 'user:u1', data: {} })).toThrow();
  });

  it('replayEmit re-emits on the right room when initialized', () => {
    const emit = jest.fn();
    const fakeIo = { to: jest.fn(() => ({ emit })) } as any;
    websocketService.initialize(fakeIo);
    websocketService.replayEmit('notification:new', { room: 'user:u1', data: { id: 'x' } });
    expect(fakeIo.to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('notification:new', { id: 'x' });
  });
});
