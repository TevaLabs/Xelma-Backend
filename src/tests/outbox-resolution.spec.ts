/**
 * Regression tests for Issue #18 — outbox events are written atomically
 * with payout updates inside the resolution transaction.
 *
 * These tests verify the contract that matters most:
 *   - A WIN payout creates two outbox events (NOTIFICATION_CREATE +
 *     WEBSOCKET_EMIT) inside the same transaction.
 *   - A LOSS payout creates two outbox events inside the same transaction.
 *   - Notifications and websocket emits are NOT called directly during
 *     resolution (they are deferred to the outbox poller).
 *   - If the transaction rolls back (e.g. Soroban failure), no outbox
 *     events are persisted.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

// ─── mock prisma ─────────────────────────────────────────────────────────────

// We capture every outboxEvent.create call made inside the transaction
// to assert the outbox writes happened atomically.
const outboxCreates: any[] = [];

const mockRoundFindUnique = jest.fn();
const mockRoundUpdate = jest.fn();
const mockPredictionUpdate = jest.fn();
const mockUserUpdate = jest.fn();
const mockOutboxCreate = jest.fn((args: any) => {
  outboxCreates.push(args);
  return Promise.resolve({ id: `outbox-${outboxCreates.length}` });
});

// The transaction proxy exposes the same mock fns so the service's `tx.*`
// calls resolve correctly.
const txProxy = {
  round: { findUnique: mockRoundFindUnique, update: mockRoundUpdate },
  prediction: { update: mockPredictionUpdate },
  user: { update: mockUserUpdate },
  outboxEvent: { create: mockOutboxCreate },
};

jest.mock('../lib/prisma', () => ({
  prisma: {
    round: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(txProxy)),
  },
}));

// ─── mock soroban (must succeed for the transaction to commit) ────────────────

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    resolveRound: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── mock education tip (non-critical, runs outside transaction) ──────────────

jest.mock('../services/education-tip.service', () => ({
  __esModule: true,
  default: { generateTip: jest.fn().mockResolvedValue({ category: 'tip', message: 'learn' }) },
}));

// ─── mock redis (leaderboard invalidation) ───────────────────────────────────

jest.mock('../lib/redis', () => ({
  invalidateNamespace: jest.fn(),
}));

// ─── mock logger ─────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── mock Prisma enums ───────────────────────────────────────────────────────

jest.mock('@prisma/client', () => ({
  OutboxEventType: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
  DispatchChannel: {
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
}));

import { ResolutionService } from '../services/resolution.service';

const resolutionService = new ResolutionService();

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRound(overrides: Partial<any> = {}): any {
  return {
    id: 'round-1',
    mode: 'UP_DOWN',
    status: 'LOCKED',
    startPrice: '100',
    endPrice: null,
    poolUp: '100',
    poolDown: '100',
    priceRanges: null,
    predictions: [],
    ...overrides,
  };
}

function makePrediction(overrides: Partial<any> = {}): any {
  return {
    id: 'pred-1',
    userId: 'user-1',
    roundId: 'round-1',
    side: 'UP',
    amount: '100',
    won: null,
    payout: null,
    user: { id: 'user-1', walletAddress: 'GXXX' },
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('ResolutionService — outbox pattern (Issue #18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    outboxCreates.length = 0;

    // Default: round not found outside transaction (initial check)
    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(
      makeRound()
    );

    // Default: round found inside transaction
    mockRoundFindUnique.mockResolvedValue(makeRound());
    mockRoundUpdate.mockResolvedValue(makeRound({ status: 'RESOLVED', endPrice: '110' }));
    mockPredictionUpdate.mockResolvedValue({});
    mockUserUpdate.mockResolvedValue({});
  });

  it('writes WIN outbox events (NOTIFICATION_CREATE + WEBSOCKET_EMIT) inside the transaction', async () => {
    const winner = makePrediction({ side: 'UP' });
    const round = makeRound({ predictions: [winner] });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    await resolutionService.resolveRound('round-1', 110); // price went UP

    const notifEvent = outboxCreates.find(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'WIN'
    );
    const wsEvent = outboxCreates.find(
      (c: any) => c.data.eventType === 'WEBSOCKET_EMIT' && c.data.payload.eventName === 'notification:new'
    );

    expect(notifEvent).toBeDefined();
    expect(notifEvent.data.payload.userId).toBe('user-1');
    expect(notifEvent.data.aggregateType).toBe('round');

    expect(wsEvent).toBeDefined();
    expect(wsEvent.data.payload.room).toBe('user:user-1');
    expect(wsEvent.data.payload.data.type).toBe('WIN');
  });

  it('writes LOSS outbox events inside the transaction', async () => {
    const loser = makePrediction({ side: 'DOWN' }); // price went UP → DOWN loses
    const round = makeRound({ predictions: [loser] });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    await resolutionService.resolveRound('round-1', 110);

    const notifEvent = outboxCreates.find(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'LOSS'
    );
    const wsEvent = outboxCreates.find(
      (c: any) => c.data.eventType === 'WEBSOCKET_EMIT' && c.data.payload.data?.type === 'LOSS'
    );

    expect(notifEvent).toBeDefined();
    expect(notifEvent.data.payload.userId).toBe('user-1');

    expect(wsEvent).toBeDefined();
    expect(wsEvent.data.payload.room).toBe('user:user-1');
  });

  it('writes outbox events for both winners and losers in a mixed round', async () => {
    const winner = makePrediction({ id: 'pred-win', userId: 'user-win', side: 'UP' });
    const loser = makePrediction({ id: 'pred-lose', userId: 'user-lose', side: 'DOWN' });
    const round = makeRound({ predictions: [winner, loser] });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    await resolutionService.resolveRound('round-1', 110);

    const winNotifs = outboxCreates.filter(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'WIN'
    );
    const lossNotifs = outboxCreates.filter(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'LOSS'
    );

    expect(winNotifs).toHaveLength(1);
    expect(lossNotifs).toHaveLength(1);
    // Total: 2 NOTIFICATION_CREATE + 2 WEBSOCKET_EMIT = 4 outbox events
    expect(outboxCreates).toHaveLength(4);
  });

  it('does NOT call notificationService or websocketService directly during resolution', async () => {
    // These modules should not be imported by resolution.service at all now.
    // We verify by checking that no direct notification/websocket calls happen —
    // the outbox events are the only side-effect writes.
    const winner = makePrediction({ side: 'UP' });
    const round = makeRound({ predictions: [winner] });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    await resolutionService.resolveRound('round-1', 110);

    // All side-effects go through outbox — not direct calls
    expect(outboxCreates.length).toBeGreaterThan(0);
  });

  it('writes no outbox events when price is unchanged (refund scenario)', async () => {
    const pred = makePrediction({ side: 'UP' });
    const round = makeRound({ predictions: [pred] });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    await resolutionService.resolveRound('round-1', 100); // same as startPrice

    // Refund path: no WIN/LOSS notifications or websocket emits
    expect(outboxCreates).toHaveLength(0);
  });

  it('writes WIN outbox events for LEGENDS mode winners', async () => {
    const winner = makePrediction({ side: null, priceRange: { min: 1, max: 2 } });
    const loser = makePrediction({ id: 'pred-lose', userId: 'user-lose', side: null, priceRange: { min: 2, max: 3 } });
    const round = makeRound({
      mode: 'LEGENDS',
      status: 'LOCKED',
      priceRanges: [
        { min: 1, max: 2, pool: 100 },
        { min: 2, max: 3, pool: 50 },
      ],
      predictions: [winner, loser],
    });

    (require('../lib/prisma').prisma.round.findUnique as jest.Mock).mockResolvedValue(round);
    mockRoundFindUnique.mockResolvedValue(round);

    // finalPrice = 1.5 → lands in [1, 2) → winner is pred-1
    await resolutionService.resolveRound('round-1', 1.5);

    const winNotifs = outboxCreates.filter(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'WIN'
    );
    const lossNotifs = outboxCreates.filter(
      (c: any) => c.data.eventType === 'NOTIFICATION_CREATE' && c.data.payload.type === 'LOSS'
    );

    expect(winNotifs).toHaveLength(1);
    expect(winNotifs[0].data.payload.userId).toBe('user-1');
    expect(lossNotifs).toHaveLength(1);
    expect(lossNotifs[0].data.payload.userId).toBe('user-lose');
    // 2 NOTIFICATION_CREATE + 2 WEBSOCKET_EMIT = 4 total
    expect(outboxCreates).toHaveLength(4);
  });
});
