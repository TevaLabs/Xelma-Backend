import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';
import { RoundLifecycleOutcome } from '../types/round.types';

const mockGetPrice = jest.fn<() => Decimal | null>();
const mockIsStale = jest.fn<() => boolean>();
const mockGetLastUpdatedAt = jest.fn<() => Date | null>();
const mockGetStalenessSeconds = jest.fn<() => number | null>();

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPrice: () => mockGetPrice(),
    isStale: () => mockIsStale(),
    getLastUpdatedAt: () => mockGetLastUpdatedAt(),
    getStalenessSeconds: () => mockGetStalenessSeconds(),
  },
}));

const mockResolveRound = jest.fn();
jest.mock('../services/resolution.service', () => ({
  __esModule: true,
  default: {
    resolveRound: (...args: any[]) => mockResolveRound(...args),
  },
}));

const mockRoundFindMany = jest.fn();
jest.mock('../lib/prisma', () => ({
  prisma: {
    round: {
      findMany: (...args: any[]) => mockRoundFindMany(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSchedule = jest.fn();
const mockCronStop = jest.fn();
jest.mock('node-cron', () => ({
  __esModule: true,
  default: {
    schedule: (...args: any[]) => {
      mockSchedule(...args);
      return { stop: mockCronStop };
    },
  },
}));

jest.mock('../utils/distributed-lock', () =>
  require('./helpers/distributed-lock.mock').passThroughLockModule(),
);

import oracleService from '../services/oracle.service';
import { oracleResolveBlockedTotal } from '../metrics/application.metrics';

describe('OracleService — unit tests & resolve skip reasons (Issue #525)', () => {
  let incSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    oracleService.stop();
    incSpy = jest.spyOn(oracleResolveBlockedTotal, 'inc');
  });

  afterEach(() => {
    oracleService.stop();
    incSpy.mockRestore();
  });

  describe('Skip reasons and metric counters', () => {
    it('skips resolve and increments invalid_price metric when price is null', async () => {
      mockGetPrice.mockReturnValue(null);

      await oracleService.resolveEligibleRounds();

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledWith({ reason: 'invalid_price' });
      expect(mockRoundFindMany).not.toHaveBeenCalled();
      expect(mockResolveRound).not.toHaveBeenCalled();
    });

    it('skips resolve and increments invalid_price metric when price is zero or negative', async () => {
      mockGetPrice.mockReturnValue(new Decimal(0));

      await oracleService.resolveEligibleRounds();

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledWith({ reason: 'invalid_price' });
      expect(mockRoundFindMany).not.toHaveBeenCalled();
      expect(mockResolveRound).not.toHaveBeenCalled();

      incSpy.mockClear();
      mockGetPrice.mockReturnValue(new Decimal(-10));

      await oracleService.resolveEligibleRounds();

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledWith({ reason: 'invalid_price' });
      expect(mockRoundFindMany).not.toHaveBeenCalled();
      expect(mockResolveRound).not.toHaveBeenCalled();
    });

    it('skips resolve and increments stale_price metric when price is stale', async () => {
      mockGetPrice.mockReturnValue(new Decimal('0.155'));
      mockIsStale.mockReturnValue(true);
      mockGetLastUpdatedAt.mockReturnValue(new Date(Date.now() - 120_000));
      mockGetStalenessSeconds.mockReturnValue(120);

      await oracleService.resolveEligibleRounds();

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledWith({ reason: 'stale_price' });
      expect(mockRoundFindMany).not.toHaveBeenCalled();
      expect(mockResolveRound).not.toHaveBeenCalled();
    });
  });

  describe('Eligible rounds resolution', () => {
    beforeEach(() => {
      mockGetPrice.mockReturnValue(new Decimal('0.25000000'));
      mockIsStale.mockReturnValue(false);
    });

    it('does nothing when no eligible rounds are found in database', async () => {
      mockRoundFindMany.mockResolvedValue([]);

      await oracleService.resolveEligibleRounds();

      expect(incSpy).not.toHaveBeenCalled();
      expect(mockRoundFindMany).toHaveBeenCalledTimes(1);
      expect(mockResolveRound).not.toHaveBeenCalled();
    });

    it('resolves eligible rounds when price is valid and fresh', async () => {
      const eligibleRounds = [
        { id: 'round-1', status: 'ACTIVE', endTime: new Date(Date.now() - 30_000) },
        { id: 'round-2', status: 'LOCKED', endTime: new Date(Date.now() - 25_000) },
      ];
      mockRoundFindMany.mockResolvedValue(eligibleRounds);
      mockResolveRound.mockResolvedValue({ outcome: RoundLifecycleOutcome.UPDATED });

      await oracleService.resolveEligibleRounds();

      expect(incSpy).not.toHaveBeenCalled();
      expect(mockResolveRound).toHaveBeenCalledTimes(2);
      expect(mockResolveRound).toHaveBeenCalledWith('round-1', '0.25');
      expect(mockResolveRound).toHaveBeenCalledWith('round-2', '0.25');
    });

    it('handles ALREADY_RESOLVED, NO_OP, and null outcomes gracefully', async () => {
      mockRoundFindMany.mockResolvedValue([
        { id: 'round-already', status: 'ACTIVE', endTime: new Date(Date.now() - 30_000) },
        { id: 'round-noop', status: 'LOCKED', endTime: new Date(Date.now() - 30_000) },
        { id: 'round-empty', status: 'LOCKED', endTime: new Date(Date.now() - 30_000) },
      ]);

      mockResolveRound
        .mockResolvedValueOnce({ outcome: RoundLifecycleOutcome.ALREADY_RESOLVED })
        .mockResolvedValueOnce({ outcome: RoundLifecycleOutcome.NO_OP })
        .mockResolvedValueOnce(null);

      await oracleService.resolveEligibleRounds();

      expect(mockResolveRound).toHaveBeenCalledTimes(3);
    });

    it('retries on resolution failure up to MAX_RESOLVE_RETRIES', async () => {
      mockRoundFindMany.mockResolvedValue([
        { id: 'round-fail', status: 'ACTIVE', endTime: new Date(Date.now() - 30_000) },
      ]);

      mockResolveRound
        .mockRejectedValueOnce(new Error('temporary db failure'))
        .mockResolvedValueOnce({ outcome: RoundLifecycleOutcome.UPDATED });

      await oracleService.resolveEligibleRounds();

      expect(mockResolveRound).toHaveBeenCalledTimes(2);
    });
  });

  describe('Service lifecycle', () => {
    it('starts cron job and reports running state', () => {
      expect(oracleService.isRunning()).toBe(false);

      oracleService.start();

      expect(oracleService.isRunning()).toBe(true);
      expect(mockSchedule).toHaveBeenCalledTimes(1);

      // Duplicate start should be ignored
      oracleService.start();
      expect(mockSchedule).toHaveBeenCalledTimes(1);
    });

    it('stops cron job cleanly', () => {
      oracleService.start();
      expect(oracleService.isRunning()).toBe(true);

      oracleService.stop();

      expect(oracleService.isRunning()).toBe(false);
      expect(mockCronStop).toHaveBeenCalledTimes(1);
    });
  });
});
