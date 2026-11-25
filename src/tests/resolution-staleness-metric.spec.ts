import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

/**
 * Issue #976 — late resolution is observable as Prometheus metrics.
 *
 * ResolutionService records an overdue round on every observation, including
 * the NO_OP path for ACTIVE rounds that the lifecycle rules refuse to settle.
 * The tests use a fixed clock so the emitted staleness value is exact.
 */

const NOW = new Date('2026-11-24T12:00:00.000Z');

const mockRoundFindUnique = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('../lib/prisma', () => ({
   __esModule: true,
   prisma: {
      round: { findUnique: mockRoundFindUnique },
      $transaction: jest.fn(),
   },
}));

jest.mock('../services/oracle', () => ({
   __esModule: true,
   default: {
      isRunning: jest.fn(() => false),
      isStale: jest.fn(() => false),
      getLastUpdatedAt: jest.fn(() => null),
      getStalenessSeconds: jest.fn(() => null),
      getStalenessThresholdMs: jest.fn(() => 60_000),
   },
}));

jest.mock('../services/soroban.service', () => ({
   __esModule: true,
   default: { resolveRound: jest.fn(), applyMoneyPathFailure: jest.fn() },
}));

jest.mock('../services/bet.service', () => ({
   __esModule: true,
   default: { resolveBet: jest.fn() },
}));

jest.mock('../services/education-tip.service', () => ({
   __esModule: true,
   default: { generateTip: jest.fn(async () => ({ category: 'tip', message: 'learn' })) },
}));

jest.mock('../services/websocket.service', () => ({
   __esModule: true,
   default: { emitRoundResolved: jest.fn() },
}));

jest.mock('../lib/redis', () => ({
   invalidateNamespace: jest.fn(async () => undefined),
   invalidateLeaderboardSortedSet: jest.fn(async () => undefined),
}));

jest.mock('../utils/logger', () => ({
   __esModule: true,
   default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import resolutionService from '../services/resolution.service';
import { RoundLifecycleOutcome } from '../types/round.types';
import {
   roundResolutionStalenessSeconds,
   roundsResolveDelayedTotal,
} from '../metrics/application.metrics';

function round(overrides: Record<string, unknown> = {}): any {
   return {
      id: 'round-1',
      mode: 'UP_DOWN',
      // ACTIVE is a no-op for settle, but still an unresolved overdue round.
      status: 'ACTIVE',
      startPrice: '100',
      endTime: new Date(NOW.getTime() - 45_000),
      predictions: [],
      ...overrides,
   };
}

describe('ResolutionService — resolution lateness metrics (#976)', () => {
   let incSpy: ReturnType<typeof jest.spyOn>;
   let setSpy: ReturnType<typeof jest.spyOn>;

   beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
      jest.clearAllMocks();
      incSpy = jest.spyOn(roundsResolveDelayedTotal, 'inc');
      setSpy = jest.spyOn(roundResolutionStalenessSeconds, 'set');
      roundResolutionStalenessSeconds.reset();
   });

   afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
   });

   it('counts and measures an unresolved round that is past its endTime', async () => {
      mockRoundFindUnique.mockResolvedValue(round());

      const result = await resolutionService.resolveRound('round-1', '100');

      expect(result).toEqual({ outcome: RoundLifecycleOutcome.NO_OP });
      expect(incSpy).toHaveBeenCalledWith({ mode: 'UP_DOWN' });
      expect(setSpy).toHaveBeenCalledWith({ mode: 'UP_DOWN' }, 45);
   });

   it('accepts a string endTime as returned by some Prisma/mock clients', async () => {
      mockRoundFindUnique.mockResolvedValue(
         round({ endTime: new Date(NOW.getTime() - 10_000).toISOString() }),
      );

      await resolutionService.resolveRound('round-1', '100');

      expect(incSpy).toHaveBeenCalledWith({ mode: 'UP_DOWN' });
      expect(setSpy).toHaveBeenCalledWith({ mode: 'UP_DOWN' }, 10);
   });

   it('does not record a round that has not reached its endTime', async () => {
      mockRoundFindUnique.mockResolvedValue(
         round({ endTime: new Date(NOW.getTime() + 60_000) }),
      );

      await resolutionService.resolveRound('round-1', '100');

      expect(incSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
   });

   it('does not record terminal rounds even when they are past endTime', async () => {
      mockRoundFindUnique
         .mockResolvedValueOnce(round({ status: 'RESOLVED' }))
         .mockResolvedValueOnce(round({ status: 'CANCELLED' }));

      await resolutionService.resolveRound('round-1', '100');
      await resolutionService.resolveRound('round-1', '100');

      expect(incSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
   });

   it('ignores a missing or malformed endTime instead of publishing a bogus value', async () => {
      mockRoundFindUnique
         .mockResolvedValueOnce(round({ endTime: null }))
         .mockResolvedValueOnce(round({ endTime: 'not-a-date' }));

      await resolutionService.resolveRound('round-1', '100');
      await resolutionService.resolveRound('round-1', '100');

      expect(incSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
   });

   it('exposes the metrics with the documented Prometheus names', () => {
      expect(roundsResolveDelayedTotal.name).toBe('rounds_resolve_delayed_total');
      expect(roundResolutionStalenessSeconds.name).toBe(
         'round_resolution_staleness_seconds',
      );
   });
});
