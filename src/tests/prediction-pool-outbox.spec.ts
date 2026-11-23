/**
 * #987: UP_DOWN prediction submit writes the pool update to the outbox
 * (WEBSOCKET_EMIT round_update) in the same transaction as the pool change,
 * and compensation announces the rollback the same way.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

const outboxCreates: any[] = [];
const txOrder: string[] = [];

const mockRoundFindUnique = jest.fn();
const mockRoundUpdate = jest.fn(() => {
  txOrder.push('round.update');
  return Promise.resolve({
    id: 'round-1',
    mode: 'UP_DOWN',
    status: 'ACTIVE',
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-01-01T00:05:00Z'),
    startPrice: 1,
    endPrice: null,
    poolUp: 100,
    poolDown: 0,
    priceRanges: null,
    resolvedAt: null,
  });
});
const mockPredictionFindUnique = jest.fn();
const mockPredictionCreate = jest.fn();
const mockPredictionUpdate = jest.fn().mockResolvedValue({});
const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();
const mockOutboxCreate = jest.fn((args: any) => {
  txOrder.push('outbox.create');
  outboxCreates.push(args);
  return Promise.resolve({ id: `outbox-${outboxCreates.length}` });
});

const txProxy = {
  round: { findUnique: mockRoundFindUnique, update: mockRoundUpdate },
  prediction: { findUnique: mockPredictionFindUnique, create: mockPredictionCreate, update: mockPredictionUpdate },
  user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
  outboxEvent: { create: mockOutboxCreate },
};

jest.mock('../lib/prisma', () => ({
  prisma: {
    round: { findUnique: jest.fn() },
    prediction: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(txProxy)),
  },
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: { placeBet: jest.fn().mockResolvedValue({ txHash: '0xabc' }) },
}));

jest.mock('../lib/redis', () => ({
  invalidateNamespace: jest.fn(),
  invalidateLeaderboardSortedSet: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/idempotency.util', () => ({
  storeIdempotencyResult: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@prisma/client', () => ({
  OutboxEventType: { NOTIFICATION_CREATE: 'NOTIFICATION_CREATE', WEBSOCKET_EMIT: 'WEBSOCKET_EMIT' },
}));

import { PredictionService } from '../services/prediction.service';
import { prisma } from '../lib/prisma';

const service = new PredictionService();

describe('PredictionService pool update outbox (#987)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    outboxCreates.length = 0;
    txOrder.length = 0;
  });

  it('writes round_update WEBSOCKET_EMIT events for UP_DOWN right after the pool update, inside the tx', async () => {
    mockRoundFindUnique.mockResolvedValue({ id: 'round-1', mode: 'UP_DOWN', status: 'ACTIVE' });
    mockPredictionFindUnique.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({ id: 'user-1', walletAddress: 'GXXX', virtualBalance: 1000 });
    mockUserUpdate.mockResolvedValue({ id: 'user-1', walletAddress: 'GXXX', virtualBalance: 900 });
    mockPredictionCreate.mockResolvedValue({
      id: 'pred-1', roundId: 'round-1', userId: 'user-1', amount: 100, side: 'UP', priceRange: null, createdAt: new Date(),
    });
    (prisma.prediction.findUniqueOrThrow as jest.Mock).mockResolvedValue({ id: 'pred-1' });

    await service.submitPrediction('user-1', 'round-1', 100, 'UP');

    expect(txOrder.slice(0, 3)).toEqual(['round.update', 'outbox.create', 'outbox.create']);
    const updates = outboxCreates.filter((c) => c.data.payload.eventName === 'round_update');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const rooms = updates.slice(0, 2).map((c) => c.data.payload.room).sort();
    expect(rooms).toEqual(['round', 'round:round-1']);
    for (const c of updates.slice(0, 2)) {
      expect(c.data.eventType).toBe('WEBSOCKET_EMIT');
      expect(c.data.aggregateType).toBe('round');
      expect(c.data.aggregateId).toBe('round-1');
      expect(c.data.payload.data.id).toBe('round-1');
    }
  });

  it('writes round_update events when a failed prediction is compensated', async () => {
    mockPredictionFindUnique.mockResolvedValue({
      id: 'pred-1', roundId: 'round-1', userId: 'user-1', amount: 100, side: 'UP',
      chainStatus: 'PENDING', compensatedAt: null, round: { mode: 'UP_DOWN' },
    });

    await service.compensatePrediction('pred-1');

    const updates = outboxCreates.filter((c) => c.data.payload.eventName === 'round_update');
    expect(updates.map((c) => c.data.payload.room).sort()).toEqual(['round', 'round:round-1']);
  });
});
