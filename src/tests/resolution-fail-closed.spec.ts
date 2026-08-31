import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * #524 — Integration tests for resolution money path under fail-closed.
 *
 * Proves that:
 *   1. Soroban failure + fail-closed → resolution aborts, transaction rolls
 *      back, no payouts, no outbox events.
 *   2. Stale oracle → resolution blocked before any DB work, metrics recorded.
 *   3. Happy path with fail-closed enabled resolves normally.
 *   4. Soroban failure + fail-open → DB-only resolution proceeds with payouts.
 *
 * Uses a transaction-proxy mock so the test exercises the real
 * ResolutionService code path (including $transaction) without requiring
 * a live database.
 */

// ─── spies ──────────────────────────────────────────────────────────────────

const applyMoneyPathFailureSpy = jest.fn();
const sorobanResolveRoundSpy = jest.fn();
const sorobanIsFailClosedSpy = jest.fn();
const oracleResolveBlockedIncSpy = jest.fn();

// ─── mock: soroban.service ─────────────────────────────────────────────────

jest.mock('../services/soroban.service', () => ({
   __esModule: true,
   default: {
      resolveRound: sorobanResolveRoundSpy,
      applyMoneyPathFailure: applyMoneyPathFailureSpy,
      isFailClosed: sorobanIsFailClosedSpy,
   },
}));

// ─── mock: oracle (staleness guard) ────────────────────────────────────────

const mockOracle = {
   isRunning: jest.fn<() => boolean>(),
   isStale: jest.fn<() => boolean>(),
   getLastUpdatedAt: jest.fn<() => Date | null>(() => null),
   getStalenessSeconds: jest.fn<() => number | null>(() => null),
   getStalenessThresholdMs: jest.fn<() => number>(() => 60_000),
};
jest.mock('../services/oracle', () => ({ __esModule: true, default: mockOracle }));

// ─── mock: metrics ──────────────────────────────────────────────────────────

jest.mock('../metrics/application.metrics', () => ({
   roundsResolvedTotal: { inc: jest.fn() },
   oracleResolveBlockedTotal: { inc: oracleResolveBlockedIncSpy },
}));

// ─── mock: non-critical side-effects ────────────────────────────────────────

jest.mock('../services/education-tip.service', () => ({
   __esModule: true,
   default: { generateTip: jest.fn().mockResolvedValue({ category: 'tip', message: 'learn' }) },
}));

jest.mock('../services/websocket.service', () => ({
   __esModule: true,
   default: { emitRoundResolved: jest.fn() },
}));

jest.mock('../lib/redis', () => ({
   invalidateNamespace: jest.fn(),
   invalidateLeaderboardSortedSet: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
   __esModule: true,
   default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── mock: prisma with transaction proxy ────────────────────────────────────

// In-memory stores that simulate the DB inside the transaction proxy.
let roundStore: Map<string, any>;
let predictionStore: Map<string, any>;
let userStore: Map<string, any>;
let outboxStore: any[];

function resetStores() {
   roundStore = new Map();
   predictionStore = new Map();
   userStore = new Map();
   outboxStore = [];
}

function seedRound(overrides: Record<string, any> = {}) {
   const round = {
      id: 'round-1',
      mode: 'UP_DOWN',
      status: 'LOCKED',
      startPrice: '100',
      endPrice: null,
      poolUp: '0',
      poolDown: '0',
      priceRanges: null,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      ...overrides,
   };
   roundStore.set(round.id, round);
   return round;
}

function seedUser(overrides: Record<string, any> = {}) {
   const user = {
      id: `user-${userStore.size}`,
      walletAddress: `G_ADDR_${userStore.size}`,
      virtualBalance: 10000,
      wins: 0,
      streak: 0,
      ...overrides,
   };
   userStore.set(user.id, user);
   return user;
}

function seedPrediction(overrides: Record<string, any> = {}) {
   const pred = {
      id: `pred-${predictionStore.size}`,
      userId: 'user-0',
      roundId: 'round-1',
      side: 'UP',
      amount: '100',
      won: null,
      payout: null,
      priceRange: null,
      user: null as any,
      ...overrides,
   };
   const user = userStore.get(pred.userId);
   pred.user = user ?? { id: pred.userId, walletAddress: 'G_ADDR' };
   predictionStore.set(pred.id, pred);
   return pred;
}

function buildRoundWithPredictions(roundId = 'round-1') {
   const round = roundStore.get(roundId);
   if (!round) return null;
   const preds = Array.from(predictionStore.values()).filter((p) => p.roundId === roundId);
   return { ...round, predictions: preds };
}

// Transaction proxy that mirrors prisma's $transaction callback shape.
const txProxy = {
   round: {
      findUnique: jest.fn(async ({ where }: any) => buildRoundWithPredictions(where.id)),
      update: jest.fn(async ({ where, data }: any) => {
         const existing = roundStore.get(where.id);
         if (!existing) return null;
         const updated = { ...existing };
         for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as any)) {
               updated[k] = Number(existing[k] ?? 0) + (v as any).increment;
            } else {
               updated[k] = v;
            }
         }
         roundStore.set(where.id, updated);
         return updated;
      }),
   },
   prediction: {
      update: jest.fn(async ({ where, data }: any) => {
         const existing = predictionStore.get(where.id);
         if (!existing) return null;
         Object.assign(existing, data);
         return existing;
      }),
   },
   user: {
      update: jest.fn(async ({ where, data }: any) => {
         const existing = userStore.get(where.id);
         if (!existing) return null;
         for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as any)) {
               existing[k] = Number(existing[k] ?? 0) + (v as any).increment;
            } else {
               existing[k] = v;
            }
         }
         return existing;
      }),
   },
   outboxEvent: {
      create: jest.fn(async ({ data }: any) => {
         const event = { id: `outbox-${outboxStore.length}`, ...data };
         outboxStore.push(event);
         return event;
      }),
   },
};

jest.mock('../lib/prisma', () => ({
   prisma: {
      round: {
         findUnique: jest.fn(async ({ where }: any) => buildRoundWithPredictions(where.id)),
      },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn(txProxy)),
   },
}));

// ─── import SUT (after mocks are wired) ─────────────────────────────────────

import resolutionService from '../services/resolution.service';
import sorobanService from '../services/soroban.service';

// ─── helpers ────────────────────────────────────────────────────────────────

function setupUpDownRound(opts: { startPrice?: number } = {}) {
   const user0 = seedUser({ id: 'user-0', virtualBalance: 9900 });
   const user1 = seedUser({ id: 'user-1', virtualBalance: 9900 });
   const round = seedRound({ startPrice: String(opts.startPrice ?? 100) });
   seedPrediction({ id: 'pred-0', userId: user0.id, roundId: round.id, side: 'UP', amount: '100' });
   seedPrediction({ id: 'pred-1', userId: user1.id, roundId: round.id, side: 'DOWN', amount: '100' });
   roundStore.set(round.id, {
      ...round,
      poolUp: '100',
      poolDown: '100',
   });
   return round.id;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('ResolutionService — fail-closed money path (#524)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      resetStores();
      mockOracle.isRunning.mockReturnValue(false);
   });

   // ─── Happy path under fail-closed ──────────────────────────────────────

   describe('Happy path with fail-closed enabled', () => {
      it('resolves normally when Soroban succeeds', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const roundId = setupUpDownRound();
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');
         expect(result.round.endPrice).toBe(110);

         expect(sorobanResolveRoundSpy).toHaveBeenCalledTimes(1);
         expect(applyMoneyPathFailureSpy).not.toHaveBeenCalled();

         const round = roundStore.get(roundId);
         expect(round.status).toBe('RESOLVED');

         const pred0 = predictionStore.get('pred-0');
         expect(pred0.won).toBe(true);
         expect(pred0.payout).toBeGreaterThan(100);

         const pred1 = predictionStore.get('pred-1');
         expect(pred1.won).toBe(false);
         expect(pred1.payout).toBe(0);
      });
   });

   // ─── Soroban failure + fail-closed → abort ─────────────────────────────

   describe('Soroban failure under fail-closed', () => {
      it('aborts resolution and rolls back all DB changes', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('Soroban RPC unavailable'));
         applyMoneyPathFailureSpy.mockImplementation((_op: string, err: unknown) => {
            throw err;
         });

         const roundId = setupUpDownRound();
         const user0Before = { ...userStore.get('user-0') };
         const user1Before = { ...userStore.get('user-1') };

         await expect(
            resolutionService.resolveRound(roundId, 110)
         ).rejects.toThrow('Soroban RPC unavailable');

         expect(applyMoneyPathFailureSpy).toHaveBeenCalledWith(
            'resolveRound',
            expect.objectContaining({ message: 'Soroban RPC unavailable' })
         );

         const round = roundStore.get(roundId);
         expect(round.status).toBe('LOCKED');
         expect(round.endPrice).toBeNull();

         expect(predictionStore.get('pred-0').won).toBeNull();
         expect(predictionStore.get('pred-0').payout).toBeNull();
         expect(predictionStore.get('pred-1').won).toBeNull();
         expect(predictionStore.get('pred-1').payout).toBeNull();

         expect(userStore.get('user-0').virtualBalance).toBe(user0Before.virtualBalance);
         expect(userStore.get('user-1').virtualBalance).toBe(user1Before.virtualBalance);
      });

      it('prevents incorrect payouts when a clear winning side exists', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('chain offline'));
         applyMoneyPathFailureSpy.mockImplementation((_op: string, err: unknown) => {
            throw err;
         });

         const roundId = setupUpDownRound();

         await expect(
            resolutionService.resolveRound(roundId, 50)
         ).rejects.toThrow();

         expect(predictionStore.get('pred-0').payout).toBeNull();
         expect(predictionStore.get('pred-1').payout).toBeNull();

         const round = roundStore.get(roundId);
         expect(round.status).toBe('LOCKED');
      });

      it('writes no outbox events on abort', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('contract error'));
         applyMoneyPathFailureSpy.mockImplementation((_op: string, err: unknown) => {
            throw err;
         });

         const roundId = setupUpDownRound();

         await expect(
            resolutionService.resolveRound(roundId, 110)
         ).rejects.toThrow();

         expect(outboxStore).toHaveLength(0);
      });
   });

   // ─── Stale oracle blocks resolution ────────────────────────────────────

   describe('Stale oracle guard with Soroban fail-closed', () => {
      it('rejects resolution when oracle is running and price is stale', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         mockOracle.isRunning.mockReturnValue(true);
         mockOracle.isStale.mockReturnValue(true);
         mockOracle.getLastUpdatedAt.mockReturnValue(new Date(Date.now() - 120_000));
         mockOracle.getStalenessSeconds.mockReturnValue(120);
         mockOracle.getStalenessThresholdMs.mockReturnValue(60_000);

         const roundId = setupUpDownRound();

         await expect(
            resolutionService.resolveRound(roundId, 110)
         ).rejects.toMatchObject({
            statusCode: 503,
            code: 'EXTERNAL_SERVICE_ERROR',
         });

         expect(sorobanResolveRoundSpy).not.toHaveBeenCalled();
         expect(roundStore.get(roundId).status).toBe('LOCKED');
         expect(oracleResolveBlockedIncSpy).toHaveBeenCalledWith({ reason: 'stale_price' });
      });

      it('allows resolution when oracle is running and price is fresh', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         mockOracle.isRunning.mockReturnValue(true);
         mockOracle.isStale.mockReturnValue(false);
         mockOracle.getLastUpdatedAt.mockReturnValue(new Date());
         mockOracle.getStalenessSeconds.mockReturnValue(2);
         mockOracle.getStalenessThresholdMs.mockReturnValue(60_000);

         const roundId = setupUpDownRound();
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');
         expect(sorobanResolveRoundSpy).toHaveBeenCalledTimes(1);
      });

      it('allows resolution when oracle is not running (API-only process)', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         mockOracle.isRunning.mockReturnValue(false);
         mockOracle.isStale.mockReturnValue(true);

         const roundId = setupUpDownRound();
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');
         expect(mockOracle.isStale).not.toHaveBeenCalled();
      });
   });

   // ─── Soroban failure + fail-open → DB-only resolution ──────────────────

   describe('Soroban failure under fail-open', () => {
      it('resolves with DB-only updates when Soroban fails', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(false);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('Soroban RPC unavailable'));
         applyMoneyPathFailureSpy.mockImplementation(() => {});

         const roundId = setupUpDownRound();
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');
         expect(result.round.endPrice).toBe(110);

         expect(applyMoneyPathFailureSpy).toHaveBeenCalledWith(
            'resolveRound',
            expect.objectContaining({ message: 'Soroban RPC unavailable' })
         );

         const pred0 = predictionStore.get('pred-0');
         expect(pred0.won).toBe(true);
         expect(pred0.payout).toBeGreaterThan(100);

         const pred1 = predictionStore.get('pred-1');
         expect(pred1.won).toBe(false);
         expect(pred1.payout).toBe(0);
      });

      it('still processes refund when price unchanged under fail-open', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(false);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('chain error'));
         applyMoneyPathFailureSpy.mockImplementation(() => {});

         const roundId = setupUpDownRound({ startPrice: 110 });
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');

         const pred0 = predictionStore.get('pred-0');
         expect(pred0.won).toBeNull();
         expect(pred0.payout).toBe(100);
      });
   });
});
