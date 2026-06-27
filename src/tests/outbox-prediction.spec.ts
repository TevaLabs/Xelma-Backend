/**
 * Regression tests for Issue #18 — prediction submission writes a
 * `prediction:placed` outbox event atomically inside the transaction.
 *
 * Verifies:
 *   - A successful UP_DOWN prediction creates a WEBSOCKET_EMIT outbox event
 *     with eventName `prediction:placed` inside the transaction.
 *   - A successful LEGENDS prediction also creates the outbox event.
 *   - The outbox event is NOT created when the transaction rolls back
 *     (e.g. Soroban failure).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

// ─── capture outbox creates ───────────────────────────────────────────────────

const outboxCreates: any[] = [];

const mockRoundFindUnique = jest.fn();
const mockRoundUpdate = jest.fn();
const mockPredictionFindUnique = jest.fn();
const mockPredictionCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();
const mockOutboxCreate = jest.fn((args: any) => {
  outboxCreates.push(args);
  return Promise.resolve({ id: `outbox-${outboxCreates.length}` });
});

const txProxy = {
  round: { findUnique: mockRoundFindUnique, update: mockRoundUpdate },
  prediction: { findUnique: mockPredictionFindUnique, create: mockPredictionCreate },
  user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
  outboxEvent: { create: mockOutboxCreate },
};

jest.mock('../lib/prisma', () => ({
  prisma: {
    round: { findUnique: jest.fn() },
    prediction: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(txProxy)),
  },
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: { placeBet: jest.fn().mockResolvedValue(undefined) },
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
  OutboxEventType: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
}));

import { PredictionService } from '../services/prediction.service';

const predictionService = new PredictionService();

const userId = 'user-1';
const roundId = 'round-1';

describe('PredictionService — outbox pattern (Issue #18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    outboxCreates.length = 0;
  });

  describe('UP_DOWN mode', () => {
    it('writes a prediction:placed WEBSOCKET_EMIT outbox event inside the transaction', async () => {
      mockRoundFindUnique.mockResolvedValue({
        id: roundId,
        mode: 'UP_DOWN',
        status: 'ACTIVE',
      });
      mockPredictionFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 1000 });
      mockUserUpdate.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 900 });

      const created = {
        id: 'pred-1',
        roundId,
        userId,
        amount: 100,
        side: 'UP',
        priceRange: null,
        createdAt: new Date(),
      };
      mockPredictionCreate.mockResolvedValue(created);
      mockRoundUpdate.mockResolvedValue({
        id: roundId,
        mode: 'UP_DOWN',
        status: 'ACTIVE',
        startTime: new Date(),
        endTime: new Date(),
        startPrice: 100,
        endPrice: null,
        poolUp: 100,
        poolDown: 0,
      });

      await predictionService.submitPrediction(userId, roundId, 100, 'UP');

      const wsEvent = outboxCreates.find(
        (c: any) =>
          c.data.eventType === 'WEBSOCKET_EMIT' &&
          c.data.payload.eventName === 'prediction:placed'
      );

      expect(wsEvent).toBeDefined();
      expect(wsEvent.data.aggregateType).toBe('prediction');
      expect(wsEvent.data.aggregateId).toBe('pred-1');
      expect(wsEvent.data.payload.room).toBe('round');
      expect(wsEvent.data.payload.data.roundId).toBe(roundId);
      expect(wsEvent.data.payload.data.side).toBe('UP');
    });

    it('does NOT write an outbox event when Soroban placeBet fails (transaction rolls back)', async () => {
      mockRoundFindUnique.mockResolvedValue({
        id: roundId,
        mode: 'UP_DOWN',
        status: 'ACTIVE',
      });
      mockPredictionFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 1000 });
      mockUserUpdate.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 900 });
      mockPredictionCreate.mockResolvedValue({
        id: 'pred-1', roundId, userId, amount: 100, side: 'UP', priceRange: null, createdAt: new Date(),
      });
      mockRoundUpdate.mockResolvedValue({});

      // Soroban fails → transaction rolls back → outboxCreate never called
      const sorobanService = require('../services/soroban.service').default;
      sorobanService.placeBet.mockRejectedValueOnce(new Error('Soroban down'));

      // The $transaction mock re-runs the fn; if placeBet throws, the fn throws
      // and the transaction mock propagates the error.
      await expect(
        predictionService.submitPrediction(userId, roundId, 100, 'UP')
      ).rejects.toThrow('Soroban down');

      // outboxCreate should NOT have been called because the error was thrown
      // before the outbox write (Soroban is called before outbox write in the code).
      // This confirms the ordering: Soroban → outbox write → commit.
      // If Soroban fails, the outbox write never happens.
      expect(outboxCreates).toHaveLength(0);
    });
  });

  describe('LEGENDS mode', () => {
    it('writes a prediction:placed WEBSOCKET_EMIT outbox event inside the transaction', async () => {
      const priceRanges = [
        { min: 1, max: 2, pool: 0 },
        { min: 2, max: 3, pool: 0 },
      ];
      mockRoundFindUnique.mockResolvedValue({
        id: roundId,
        mode: 'LEGENDS',
        status: 'ACTIVE',
        priceRanges,
      });
      mockPredictionFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 500 });
      mockUserUpdate.mockResolvedValue({ id: userId, walletAddress: 'GXXX', virtualBalance: 450 });

      const created = {
        id: 'pred-2',
        roundId,
        userId,
        amount: 50,
        side: null,
        priceRange: { min: 1, max: 2 },
        createdAt: new Date(),
      };
      mockPredictionCreate.mockResolvedValue(created);
      mockRoundUpdate.mockResolvedValue({
        id: roundId,
        mode: 'LEGENDS',
        status: 'ACTIVE',
        startTime: new Date(),
        endTime: new Date(),
        startPrice: 100,
        endPrice: null,
        priceRanges: [
          { min: 1, max: 2, pool: 50 },
          { min: 2, max: 3, pool: 0 },
        ],
      });

      await predictionService.submitPrediction(userId, roundId, 50, undefined, { min: 1, max: 2 });

      const wsEvent = outboxCreates.find(
        (c: any) =>
          c.data.eventType === 'WEBSOCKET_EMIT' &&
          c.data.payload.eventName === 'prediction:placed'
      );

      expect(wsEvent).toBeDefined();
      expect(wsEvent.data.aggregateId).toBe('pred-2');
      expect(wsEvent.data.payload.room).toBe('round');
      expect(wsEvent.data.payload.data.priceRange).toEqual({ min: 1, max: 2 });
    });
  });
});
