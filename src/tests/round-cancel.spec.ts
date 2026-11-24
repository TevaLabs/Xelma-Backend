import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BetMode, BetStatus, OutboxEventType } from '@prisma/client';

/**
 * Issue #977 — admin cancellation with transactional refunds + outbox.
 *
 * Prisma is mocked with a transaction proxy so these tests exercise the real
 * RoundService code path (including rollback on a thrown write) without a DB.
 */

const mockRoundFindUnique = jest.fn<(...args: any[]) => Promise<any>>();
const mockTransaction = jest.fn<(fn: (tx: any) => Promise<any>) => Promise<any>>();

const tx = {
  round: {
    findUnique: jest.fn<(...args: any[]) => Promise<any>>(),
  },
  prediction: {
    update: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
  },
  user: {
    update: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
  },
  bet: {
    findMany: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
    update: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
  },
  outboxEvent: {
    create: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  prisma: {
    round: { findUnique: (...args: any[]) => mockRoundFindUnique(...args) },
    $transaction: (fn: (tx: any) => Promise<any>) => mockTransaction(fn),
  },
}));

const mockTransitionRound = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../services/round-lifecycle.service', () => ({
  __esModule: true,
  default: { transitionRound: (...args: any[]) => mockTransitionRound(...args) },
}));

jest.mock('../services/websocket.service', () => ({
  __esModule: true,
  default: { emitRoundUpdate: jest.fn() },
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    createRound: jest.fn(),
    resolveRound: jest.fn(),
    applyMoneyPathFailure: jest.fn(),
    isReady: jest.fn(() => false),
  },
}));

jest.mock('../services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: jest.fn(async () => ({})) },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import roundService from '../services/round.service';
import websocketService from '../services/websocket.service';
import { ErrorCode } from '../utils/errors';
import { RoundLifecycleOutcome } from '../types/round.types';
import { IllegalRoundTransitionError } from '../utils/errors';

function makeRound(overrides: Record<string, any> = {}): any {
  return {
    id: 'round-1',
    mode: 'UP_DOWN',
    status: 'LOCKED',
    startPrice: '100',
    endTime: new Date(),
    predictions: [],
    ...overrides,
  };
}

function prediction(id: string, userId: string, amount: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    userId,
    roundId: 'round-1',
    amount,
    side: 'UP',
    chainStatus: 'CONFIRMED',
    ...overrides,
  };
}

describe('RoundService.cancelRound (#977)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation((fn) => fn(tx));

    const allPredictions = [
      prediction('pred-1', 'user-1', '10.00000000'),
      prediction('pred-2', 'user-2', '20.00000000'),
    ];
    tx.round.findUnique.mockImplementation(async (args: any) => {
      const where = args?.include?.predictions?.where;
      const statuses: string[] | undefined = where?.chainStatus?.in;
      return makeRound({
        predictions: statuses
          ? allPredictions.filter((p) => statuses.includes(p.chainStatus))
          : allPredictions,
      });
    });
    const allBets = [
      { id: 'bet-1', userId: 'user-1', roundId: 'round-1', status: BetStatus.CONFIRMED, mode: BetMode.UP_DOWN },
    ];
    tx.bet.findMany.mockImplementation(async (args: any) =>
      allBets.filter(
        (bet) =>
          bet.userId === args.where.userId && bet.roundId === args.where.roundId,
      ),
    );
    mockTransitionRound.mockResolvedValue(makeRound({ status: 'CANCELLED' }));
  });

  it('refunds participants and writes outbox rows atomically in one transaction', async () => {
    mockRoundFindUnique.mockResolvedValue(
      makeRound({
        predictions: [
          prediction('pred-1', 'user-1', '10.00000000'),
          prediction('pred-2', 'user-2', '20.00000000'),
        ],
      }),
    );

    const result = await roundService.cancelRound('round-1');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransitionRound).toHaveBeenCalledWith(
      'round-1',
      'CANCELLED',
      { tx },
      false,
    );

    expect(tx.prediction.update).toHaveBeenCalledTimes(2);
    expect(tx.prediction.update).toHaveBeenCalledWith({
      where: { id: 'pred-1' },
      data: { won: null, payout: 10 },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { virtualBalance: { increment: 10 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: { virtualBalance: { increment: 20 } },
    });

    // Bet resolution is inline (no nested transaction) but still carries the
    // same BET_RESOLVED outbox payload the poller expects.
    expect(tx.bet.update).toHaveBeenCalledWith({
      where: { id: 'bet-1' },
      data: { status: BetStatus.RESOLVED, resolvedAt: expect.any(Date) },
    });

    const events = tx.outboxEvent.create.mock.calls.map((call: any) => call[0].data);
    expect(events.filter((e: any) => e.eventType === OutboxEventType.BET_RESOLVED)).toHaveLength(1);
    expect(events.filter((e: any) => e.eventType === OutboxEventType.NOTIFICATION_CREATE)).toHaveLength(2);
    const emits = events.filter((e: any) => e.eventType === OutboxEventType.WEBSOCKET_EMIT);
    // One notification emit per participant + one round-level emit.
    expect(emits).toHaveLength(3);
    expect(emits.some((e: any) => e.payload.eventName === 'round:cancelled')).toBe(true);

    expect(result.outcome).toBe(RoundLifecycleOutcome.UPDATED);
    expect(result.refundedCount).toBe(2);
    expect(result.refundedTotal).toBe(30);
    expect(websocketService.emitRoundUpdate).toHaveBeenCalledTimes(1);
  });

  it('excludes predictions and bets that are not settled on-chain', async () => {
    mockRoundFindUnique.mockResolvedValue(
      makeRound({
        predictions: [
          prediction('pred-1', 'user-1', '10.00000000'),
          prediction('pred-pending', 'user-3', '99.00000000', {
            chainStatus: 'PENDING',
          }),
        ],
      }),
    );
    const allBets = [
      { id: 'bet-confirmed', userId: 'user-1', roundId: 'round-1', status: BetStatus.CONFIRMED, mode: BetMode.UP_DOWN },
      { id: 'bet-submitted', userId: 'user-1', roundId: 'round-1', status: BetStatus.SUBMITTED, mode: BetMode.UP_DOWN },
    ];
    tx.bet.findMany.mockImplementation(async (args: any) =>
      allBets.filter(
        (bet) =>
          bet.userId === args.where.userId &&
          bet.roundId === args.where.roundId &&
          bet.status === args.where.status,
      ),
    );
    tx.round.findUnique.mockImplementation(async (args: any) => {
      const statuses: string[] | undefined =
        args?.include?.predictions?.where?.chainStatus?.in;
      return makeRound({
        predictions: statuses
          ? [prediction('pred-1', 'user-1', '10.00000000')].filter((p) =>
              statuses.includes(p.chainStatus),
            )
          : [prediction('pred-1', 'user-1', '10.00000000')],
      });
    });

    const result = await roundService.cancelRound('round-1');

    expect(result.refundedCount).toBe(1);
    expect(result.refundedTotal).toBe(10);
    expect(tx.prediction.update).toHaveBeenCalledTimes(1);
    expect(tx.prediction.update).toHaveBeenCalledWith({
      where: { id: 'pred-1' },
      data: { won: null, payout: 10 },
    });
    expect(tx.bet.update).toHaveBeenCalledTimes(1);
  });

  it('cancels a round with no participants without creating per-user refunds', async () => {
    mockRoundFindUnique.mockResolvedValue(makeRound({ predictions: [] }));
    tx.round.findUnique.mockResolvedValue(makeRound({ predictions: [] }));

    const result = await roundService.cancelRound('round-1');

    expect(result.outcome).toBe(RoundLifecycleOutcome.UPDATED);
    expect(result.refundedCount).toBe(0);
    expect(result.refundedTotal).toBe(0);
    expect(tx.prediction.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create.mock.calls[0][0].data.payload.eventName).toBe(
      'round:cancelled',
    );
  });

  it('is idempotent for an already-cancelled round', async () => {
    mockRoundFindUnique.mockResolvedValue(makeRound({ status: 'CANCELLED' }));

    const result = await roundService.cancelRound('round-1');

    expect(result.outcome).toBe(RoundLifecycleOutcome.ALREADY_CANCELLED);
    expect(result.refundedCount).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('refuses to cancel an already-resolved round', async () => {
    mockRoundFindUnique.mockResolvedValue(makeRound({ status: 'RESOLVED' }));

    await expect(roundService.cancelRound('round-1')).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.ROUND_ALREADY_RESOLVED,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('refuses to cancel a round that is not ACTIVE or LOCKED', async () => {
    mockRoundFindUnique.mockResolvedValue(makeRound({ status: 'PENDING' }));

    await expect(roundService.cancelRound('round-1')).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.CONFLICT,
    });
  });

  it('returns NOT_FOUND for an unknown round', async () => {
    mockRoundFindUnique.mockResolvedValue(null);

    await expect(roundService.cancelRound('missing')).rejects.toMatchObject({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('folds a concurrent cancel race into the idempotent outcome', async () => {
    mockRoundFindUnique
      .mockResolvedValueOnce(makeRound())
      .mockResolvedValueOnce(makeRound({ status: 'CANCELLED' }));
    mockTransitionRound.mockRejectedValueOnce(
      new IllegalRoundTransitionError('CANCELLED', 'CANCELLED'),
    );

    const result = await roundService.cancelRound('round-1');

    expect(result.outcome).toBe(RoundLifecycleOutcome.ALREADY_CANCELLED);
    expect(result.refundedCount).toBe(0);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(websocketService.emitRoundUpdate).not.toHaveBeenCalled();
  });

  it('propagates a write failure and does not emit a websocket update', async () => {
    mockRoundFindUnique.mockResolvedValue(
      makeRound({ predictions: [prediction('pred-1', 'user-1', '10.00000000')] }),
    );
    tx.outboxEvent.create.mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(roundService.cancelRound('round-1')).rejects.toThrow(
      'outbox unavailable',
    );
    expect(websocketService.emitRoundUpdate).not.toHaveBeenCalled();
  });
});
