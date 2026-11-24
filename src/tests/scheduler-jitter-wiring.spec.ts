import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Issue #978 — the auto-resolve cron actually applies the jitter helper before
 * doing any work. The helper's own delay math is covered in
 * round-scheduler-jitter.spec.ts; this suite only proves the wiring.
 */

const calls: string[] = [];
const mockApplyJitter = jest.fn<(deps?: any) => Promise<number>>(async () => {
   calls.push('jitter');
   return 0;
});

jest.mock('node-cron', () => ({
   __esModule: true,
   default: { schedule: jest.fn(() => ({ stop: jest.fn() })) },
   schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../services/round-scheduler.service', () => ({
   __esModule: true,
   applyAutoResolveJitter: (...args: any[]) => mockApplyJitter(...args),
   getAutoResolveJitterMs: jest.fn(() => 5_000),
}));

jest.mock('../utils/distributed-lock', () =>
   require('./helpers/distributed-lock.mock').passThroughLockModule(),
);

jest.mock('../services/oracle', () => ({
   __esModule: true,
   default: { getPrice: jest.fn(), isStale: jest.fn() },
}));

jest.mock('../services/resolution.service', () => ({
   __esModule: true,
   default: { resolveRound: jest.fn() },
}));

jest.mock('../services/notification.service', () => ({
   __esModule: true,
   default: { cleanupOldNotifications: jest.fn() },
}));

jest.mock('../services/payout-reconciliation.service', () => ({
   __esModule: true,
   default: { run: jest.fn() },
}));

jest.mock('../lib/prisma', () => ({
   __esModule: true,
   prisma: {
      round: { findMany: jest.fn(async () => []) },
      notification: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      $disconnect: jest.fn(async () => undefined),
   },
}));

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import schedulerService from '../services/scheduler.service';

describe('auto-resolve cron jitter wiring (#978)', () => {
   const originalEnabled = process.env.AUTO_RESOLVE_ENABLED;
   const originalInterval = process.env.AUTO_RESOLVE_INTERVAL_SECONDS;

   beforeEach(() => {
      jest.clearAllMocks();
      calls.length = 0;
      process.env.AUTO_RESOLVE_ENABLED = 'true';
      process.env.AUTO_RESOLVE_INTERVAL_SECONDS = '30';
      mockApplyJitter.mockImplementation(async () => {
         calls.push('jitter');
         return 0;
      });
   });

   afterEach(() => {
      schedulerService.stop();
      if (originalEnabled === undefined) {
         delete process.env.AUTO_RESOLVE_ENABLED;
      } else {
         process.env.AUTO_RESOLVE_ENABLED = originalEnabled;
      }
      if (originalInterval === undefined) {
         delete process.env.AUTO_RESOLVE_INTERVAL_SECONDS;
      } else {
         process.env.AUTO_RESOLVE_INTERVAL_SECONDS = originalInterval;
      }
   });

   it('waits for jitter before querying rounds on a scheduled tick', async () => {
      const findManySpy = jest
         .spyOn(prisma.round, 'findMany')
         .mockImplementation(async () => {
            calls.push('findMany');
            return [];
         });

      schedulerService.start();

      const cronCalls = (cron.schedule as unknown as jest.Mock).mock.calls;
      const autoResolveCall = cronCalls.find(
         ([expression]: [string]) => expression === '*/30 * * * * *',
      );
      expect(autoResolveCall).toBeDefined();

      await autoResolveCall![1]();

      expect(mockApplyJitter).toHaveBeenCalledTimes(1);
      expect(findManySpy).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['jitter', 'findMany']);

      findManySpy.mockRestore();
   });
});
