import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * Issue #646 — Integration tests for resolution money path under fail-closed.
 *
 * Proves that:
 *   Case A: priceOracle.isStale() === true ⇒ no payout writes, resolution blocked before any DB work, metrics recorded.
 *   Case B: fail-closed + Soroban reject ⇒ no payout writes, round not falsely RESOLVED, transaction rolled back.
 *   Case C: healthy oracle + successful chain ⇒ resolve proceeds with correct payout distributions (happy path control).
 *   Control: Soroban failure + fail-open ⇒ DB-only resolution proceeds with payouts.
 *
 * Uses a transaction-proxy mock so the test exercises the real
 * ResolutionService code path (including $transaction, bet reconciliation, and outbox creation)
 * without requiring a live database.
 */

// ─── spies ──────────────────────────────────────────────────────────────────

const applyMoneyPathFailureSpy = jest.fn();
const sorobanResolveRoundSpy = jest.fn();
const sorobanIsFailClosedSpy = jest.fn();
const oracleResolveBlockedIncSpy = jest.fn();
const resolveBetSpy = jest.fn();

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

// ─── mock: bet.service ─────────────────────────────────────────────────────

jest.mock('../services/bet.service', () => ({
   __esModule: true,
   default: {
      resolveBet: resolveBetSpy,
   },
}));

// ─── mock: metrics ──────────────────────────────────────────────────────────

jest.mock('../metrics/application.metrics', () => ({
   roundsResolvedTotal: { inc: jest.fn() },
   oracleResolveBlockedTotal: { inc: oracleResolveBlockedIncSpy },
}));

// ─── mock: non-critical side-effects ────────────────────────────────────────

jest.mock('../services/education-tip.service', () => ({
   __esModule: true,
   default: { generateTip: jest.fn().mockResolvedValue({ category: 'tip', message: 'learn' }) },
   EducationTipService: jest.fn(),
}));

jest.mock('../services/websocket.service', () => ({
   __esModule: true,
   default: { emitRoundResolved: jest.fn() },
   WebSocketService: jest.fn(),
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
let betStore: Map<string, any>;
let outboxStore: any[];

function resetStores() {
   roundStore = new Map();
   predictionStore = new Map();
   userStore = new Map();
   betStore = new Map();
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

function seedBet(overrides: Record<string, any> = {}) {
   const bet = {
      id: `bet-${betStore.size}`,
      userId: 'user-0',
      roundId: 'round-1',
      status: 'CONFIRMED',
      amount: 100,
      won: null,
      payout: null,
      ...overrides,
   };
   betStore.set(bet.id, bet);
   return bet;
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
      // The lifecycle state machine settles rounds via updateMany (Issue #490):
      // it atomically matches on the allowed source states and updates the
      // status in one statement.
      updateMany: jest.fn(async ({ where, data }: any) => {
         const existing = roundStore.get(where.id);
         if (!existing) return { count: 0 };
         if (where.status && !(where.status as any).in?.includes(existing.status)) {
            return { count: 0 };
         }
         const updated = { ...existing };
         for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in (v as any)) {
               updated[k] = Number(existing[k] ?? 0) + (v as any).increment;
            } else if (k !== 'predictions') {
               updated[k] = v;
            }
         }
         roundStore.set(where.id, updated);
         return { count: 1 };
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
   bet: {
      findFirst: jest.fn(async ({ where }: any) => {
         for (const bet of betStore.values()) {
            let match = true;
            if (where.userId && bet.userId !== where.userId) match = false;
            if (where.roundId && bet.roundId !== where.roundId) match = false;
            if (where.status && bet.status !== where.status) match = false;
            if (match) return bet;
         }
         return null;
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

// ─── helpers ────────────────────────────────────────────────────────────────

function setupUpDownRound(opts: { startPrice?: number } = {}) {
   const user0 = seedUser({ id: 'user-0', virtualBalance: 9900 });
   const user1 = seedUser({ id: 'user-1', virtualBalance: 9900 });
   const round = seedRound({ startPrice: String(opts.startPrice ?? 100) });
   seedPrediction({ id: 'pred-0', userId: user0.id, roundId: round.id, side: 'UP', amount: '100' });
   seedPrediction({ id: 'pred-1', userId: user1.id, roundId: round.id, side: 'DOWN', amount: '100' });
   seedBet({ id: 'bet-0', userId: user0.id, roundId: round.id, amount: 100 });
   seedBet({ id: 'bet-1', userId: user1.id, roundId: round.id, amount: 100 });
   roundStore.set(round.id, {
      ...round,
      poolUp: '100',
      poolDown: '100',
   });
   return round.id;
}

function setupLegendsRound() {
   const user0 = seedUser({ id: 'user-0', virtualBalance: 9900 });
   const user1 = seedUser({ id: 'user-1', virtualBalance: 9900 });
   const priceRanges = [
      { min: 90, max: 100, pool: 100 },
      { min: 100, max: 110, pool: 100 },
   ];
   const round = seedRound({
      id: 'round-legends',
      mode: 'LEGENDS',
      status: 'LOCKED',
      startPrice: '100',
      priceRanges,
   });
   seedPrediction({
      id: 'pred-0',
      userId: user0.id,
      roundId: round.id,
      side: null,
      amount: '100',
      priceRange: { min: 90, max: 100 },
   });
   seedPrediction({
      id: 'pred-1',
      userId: user1.id,
      roundId: round.id,
      side: null,
      amount: '100',
      priceRange: { min: 100, max: 110 },
   });
   seedBet({ id: 'bet-0', userId: user0.id, roundId: round.id, amount: 100 });
   seedBet({ id: 'bet-1', userId: user1.id, roundId: round.id, amount: 100 });
   return round.id;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('ResolutionService — fail-closed money path & staleness (#646)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      resetStores();
      mockOracle.isRunning.mockReturnValue(false);
   });

   // ─── Case A: Stale / Invalid Oracle ─────────────────────────────────────

   describe('Case A: Stale or invalid oracle blocks resolution', () => {
      it('rejects resolution and prevents payout writes when oracle is running and stale', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         mockOracle.isRunning.mockReturnValue(true);
         mockOracle.isStale.mockReturnValue(true);
         mockOracle.getLastUpdatedAt.mockReturnValue(new Date(Date.now() - 120_000));
         mockOracle.getStalenessSeconds.mockReturnValue(120);
         mockOracle.getStalenessThresholdMs.mockReturnValue(60_000);

         const roundId = setupUpDownRound();
         const user0Before = { ...userStore.get('user-0') };
         const user1Before = { ...userStore.get('user-1') };

         await expect(
            resolutionService.resolveRound(roundId, 110)
         ).rejects.toMatchObject({
            statusCode: 503,
            code: 'EXTERNAL_SERVICE_ERROR',
         });

         // Soroban must not be called
         expect(sorobanResolveRoundSpy).not.toHaveBeenCalled();

         // Round status remains locked, no payouts written
         const round = roundStore.get(roundId);
         expect(round.status).toBe('LOCKED');
         expect(round.endPrice).toBeNull();

         expect(predictionStore.get('pred-0').won).toBeNull();
         expect(predictionStore.get('pred-0').payout).toBeNull();
         expect(predictionStore.get('pred-1').won).toBeNull();
         expect(predictionStore.get('pred-1').payout).toBeNull();

         expect(userStore.get('user-0').virtualBalance).toBe(user0Before.virtualBalance);
         expect(userStore.get('user-1').virtualBalance).toBe(user1Before.virtualBalance);

         expect(outboxStore).toHaveLength(0);
         expect(resolveBetSpy).not.toHaveBeenCalled();
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

      it('rejects LEGENDS resolution when price ranges are empty', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const user0 = seedUser({ id: 'user-0', virtualBalance: 9900 });
         const round = seedRound({
            id: 'round-invalid-ranges',
            mode: 'LEGENDS',
            status: 'LOCKED',
            startPrice: '100',
            priceRanges: [], // empty array
         });
         seedPrediction({
            id: 'pred-0',
            userId: user0.id,
            roundId: round.id,
            amount: '100',
         });

         await expect(
            resolutionService.resolveRound(round.id, 110)
         ).rejects.toThrow('LEGENDS round has no configured price ranges');

         expect(roundStore.get(round.id).status).toBe('LOCKED');
         expect(predictionStore.get('pred-0').payout).toBeNull();
      });

      it('rejects LEGENDS resolution when price ranges have invalid bounds', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const user0 = seedUser({ id: 'user-0', virtualBalance: 9900 });
         const round = seedRound({
            id: 'round-bad-ranges',
            mode: 'LEGENDS',
            status: 'LOCKED',
            startPrice: '100',
            priceRanges: [{ min: 110, max: 100, pool: 100 }], // min > max invalid range
         });
         seedPrediction({
            id: 'pred-0',
            userId: user0.id,
            roundId: round.id,
            amount: '100',
         });

         await expect(
            resolutionService.resolveRound(round.id, 110)
         ).rejects.toThrow();

         expect(roundStore.get(round.id).status).toBe('LOCKED');
         expect(predictionStore.get('pred-0').payout).toBeNull();
      });
   });

   // ─── Case B: Fail-Closed + Soroban Reject ───────────────────────────────

   describe('Case B: Fail-closed + Soroban failure prevents payouts and false resolution', () => {
      it('aborts resolution, rolls back DB changes, and preserves round LOCKED status in UP_DOWN mode', async () => {
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

         // Round not falsely RESOLVED
         const round = roundStore.get(roundId);
         expect(round.status).toBe('LOCKED');
         expect(round.endPrice).toBeNull();

         // Predictions remain un-settled
         expect(predictionStore.get('pred-0').won).toBeNull();
         expect(predictionStore.get('pred-0').payout).toBeNull();
         expect(predictionStore.get('pred-1').won).toBeNull();
         expect(predictionStore.get('pred-1').payout).toBeNull();

         // User virtual balances and stats unmodified
         expect(userStore.get('user-0').virtualBalance).toBe(user0Before.virtualBalance);
         expect(userStore.get('user-1').virtualBalance).toBe(user1Before.virtualBalance);
         expect(userStore.get('user-0').wins).toBe(user0Before.wins);
         expect(userStore.get('user-0').streak).toBe(user0Before.streak);

         // No bets resolved and no notifications created
         expect(resolveBetSpy).not.toHaveBeenCalled();
         expect(outboxStore).toHaveLength(0);
      });

      it('prevents incorrect payouts when a clear winning side exists (DOWN wins)', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('chain offline'));
         applyMoneyPathFailureSpy.mockImplementation((_op: string, err: unknown) => {
            throw err;
         });

         const roundId = setupUpDownRound();

         await expect(
            resolutionService.resolveRound(roundId, 50)
         ).rejects.toThrow('chain offline');

         expect(predictionStore.get('pred-0').payout).toBeNull();
         expect(predictionStore.get('pred-1').payout).toBeNull();

         const round = roundStore.get(roundId);
         expect(round.status).toBe('LOCKED');
         expect(round.endPrice).toBeNull();
         expect(outboxStore).toHaveLength(0);
      });

      it('writes no outbox events or notifications on Soroban reject', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockRejectedValue(new Error('contract error'));
         applyMoneyPathFailureSpy.mockImplementation((_op: string, err: unknown) => {
            throw err;
         });

         const roundId = setupUpDownRound();

         await expect(
            resolutionService.resolveRound(roundId, 110)
         ).rejects.toThrow('contract error');

         expect(outboxStore).toHaveLength(0);
         expect(resolveBetSpy).not.toHaveBeenCalled();
      });
   });

   // ─── Case C: Healthy Oracle + Successful Chain (Happy Path Control) ──────

   describe('Case C: Healthy oracle + successful chain resolves round correctly', () => {
      it('resolves UP_DOWN round normally with payouts and outbox events when Soroban succeeds', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const roundId = setupUpDownRound();
         const result = await resolutionService.resolveRound(roundId, 110);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');
         expect(result.round.endPrice).toBe(110);

         expect(sorobanResolveRoundSpy).toHaveBeenCalledTimes(1);
         expect(applyMoneyPathFailureSpy).not.toHaveBeenCalled();

         // Round persisted as RESOLVED
         const round = roundStore.get(roundId);
         expect(round.status).toBe('RESOLVED');

         // Winning prediction (UP) rewarded, losing prediction (DOWN) marked 0
         const pred0 = predictionStore.get('pred-0');
         expect(pred0.won).toBe(true);
         expect(pred0.payout).toBeGreaterThan(100);

         const pred1 = predictionStore.get('pred-1');
         expect(pred1.won).toBe(false);
         expect(pred1.payout).toBe(0);

         // User balance incremented for winner
         expect(userStore.get('user-0').virtualBalance).toBeGreaterThan(9900);
         expect(userStore.get('user-0').wins).toBe(1);
         expect(userStore.get('user-0').streak).toBe(1);

         // Bets resolved
         expect(resolveBetSpy).toHaveBeenCalledWith('bet-0', true, expect.any(Number));
         expect(resolveBetSpy).toHaveBeenCalledWith('bet-1', false, 0);

         // Outbox events written for notifications and websocket emit
         expect(outboxStore.length).toBeGreaterThanOrEqual(4);
      });

      it('refunds predictions and resolves bets as refund when price is unchanged', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const roundId = setupUpDownRound({ startPrice: 100 });
         const result = await resolutionService.resolveRound(roundId, 100);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');

         const pred0 = predictionStore.get('pred-0');
         expect(pred0.won).toBeNull();
         expect(pred0.payout).toBe(100);

         const pred1 = predictionStore.get('pred-1');
         expect(pred1.won).toBeNull();
         expect(pred1.payout).toBe(100);

         expect(userStore.get('user-0').virtualBalance).toBe(10000);
         expect(userStore.get('user-1').virtualBalance).toBe(10000);

         expect(resolveBetSpy).toHaveBeenCalledWith('bet-0', false, 100);
         expect(resolveBetSpy).toHaveBeenCalledWith('bet-1', false, 100);
      });

      it('resolves LEGENDS round correctly to winning range', async () => {
         sorobanIsFailClosedSpy.mockReturnValue(true);
         sorobanResolveRoundSpy.mockResolvedValue(undefined);

         const roundId = setupLegendsRound();
         // Final price 105 falls into [100, 110] range (user-1)
         const result = await resolutionService.resolveRound(roundId, 105);

         expect(result.outcome).toBe('updated');
         expect(result.round.status).toBe('RESOLVED');

         const pred0 = predictionStore.get('pred-0'); // [90, 100]
         expect(pred0.won).toBe(false);
         expect(pred0.payout).toBe(0);

         const pred1 = predictionStore.get('pred-1'); // [100, 110]
         expect(pred1.won).toBe(true);
         expect(pred1.payout).toBeGreaterThan(100);

         expect(userStore.get('user-1').virtualBalance).toBeGreaterThan(9900);
         expect(userStore.get('user-1').wins).toBe(1);

         expect(resolveBetSpy).toHaveBeenCalledWith('bet-1', true, expect.any(Number));
         expect(resolveBetSpy).toHaveBeenCalledWith('bet-0', false, 0);
      });
   });

   // ─── Control Comparison: Soroban Failure + Fail-Open ─────────────────────

   describe('Control: Soroban failure under fail-open', () => {
      it('resolves with DB-only updates when Soroban fails under fail-open', async () => {
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
