import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Issue #978 — configurable jitter before scheduled auto-resolution.
 *
 * The helper lives in round-scheduler.service.ts (the file named by the issue)
 * and is wired into the auto-resolve cron in scheduler.service.ts. Dependencies
 * are mocked so this suite exercises the pure configuration/delay logic.
 */

jest.mock('node-cron', () => ({
   __esModule: true,
   default: { schedule: jest.fn(() => ({ stop: jest.fn() })) },
   schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../services/round.service', () => ({
   __esModule: true,
   default: { startRound: jest.fn(), autoLockExpiredRounds: jest.fn() },
}));

jest.mock('../services/oracle', () => ({
   __esModule: true,
   default: { getPrice: jest.fn(), isStale: jest.fn() },
}));

jest.mock('../utils/distributed-lock', () => ({
   withDistributedLock: jest.fn(async (_name: string, fn: any) =>
      fn({ assertHeld: jest.fn() }),
   ),
   isLockLostError: jest.fn(() => false),
}));

jest.mock('../lib/prisma', () => ({
   __esModule: true,
   prisma: { round: { count: jest.fn(), findFirst: jest.fn() } },
}));

import {
   applyAutoResolveJitter,
   getAutoResolveJitterMs,
} from '../services/round-scheduler.service';

describe('auto-resolve jitter (#978)', () => {
   const originalJitter = process.env.AUTO_RESOLVE_JITTER_MS;
   const originalInterval = process.env.AUTO_RESOLVE_INTERVAL_SECONDS;

   beforeEach(() => {
      delete process.env.AUTO_RESOLVE_JITTER_MS;
      delete process.env.AUTO_RESOLVE_INTERVAL_SECONDS;
   });

   afterEach(() => {
      if (originalJitter === undefined) {
         delete process.env.AUTO_RESOLVE_JITTER_MS;
      } else {
         process.env.AUTO_RESOLVE_JITTER_MS = originalJitter;
      }
      if (originalInterval === undefined) {
         delete process.env.AUTO_RESOLVE_INTERVAL_SECONDS;
      } else {
         process.env.AUTO_RESOLVE_INTERVAL_SECONDS = originalInterval;
      }
   });

   describe('getAutoResolveJitterMs', () => {
      it('defaults to 5 seconds with the default 30-second interval', () => {
         expect(getAutoResolveJitterMs()).toBe(5_000);
      });

      it('honours an explicit delay', () => {
         expect(getAutoResolveJitterMs('2500')).toBe(2_500);
      });

      it('allows zero to disable jitter', () => {
         expect(getAutoResolveJitterMs('0')).toBe(0);
      });

      it('caps the delay below the configured auto-resolve interval', () => {
         expect(getAutoResolveJitterMs('5000', '1')).toBe(999);
         expect(getAutoResolveJitterMs(undefined, '2')).toBe(1_999);
      });

      it('falls back to the default for invalid values', () => {
         expect(getAutoResolveJitterMs('-1')).toBe(5_000);
         expect(getAutoResolveJitterMs('abc')).toBe(5_000);
         expect(getAutoResolveJitterMs('1.5')).toBe(5_000);
         expect(getAutoResolveJitterMs('', '0')).toBe(5_000);
      });

      it('reads both values from the environment by default', () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '750';
         process.env.AUTO_RESOLVE_INTERVAL_SECONDS = '10';

         expect(getAutoResolveJitterMs()).toBe(750);
      });
   });

   describe('applyAutoResolveJitter', () => {
      it('waits for a deterministic injected delay before returning it', async () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '5000';
         const random = jest.fn<() => number>(() => 0.5);
         const sleep = jest.fn<(ms: number) => Promise<void>>(
            async () => undefined,
         );

         const delay = await applyAutoResolveJitter({ random, sleep });

         expect(delay).toBe(2_500);
         expect(random).toHaveBeenCalledTimes(1);
         expect(sleep).toHaveBeenCalledTimes(1);
         expect(sleep).toHaveBeenCalledWith(2_500);
      });

      it('does not sleep when the sampled delay is zero', async () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '5000';
         const sleep = jest.fn<(ms: number) => Promise<void>>(
            async () => undefined,
         );

         const delay = await applyAutoResolveJitter({
            random: () => 0,
            sleep,
         });

         expect(delay).toBe(0);
         expect(sleep).not.toHaveBeenCalled();
      });

      it('can apply the full configured maximum', async () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '1000';
         const sleep = jest.fn<(ms: number) => Promise<void>>(
            async () => undefined,
         );

         const delay = await applyAutoResolveJitter({
            random: () => 1,
            sleep,
         });

         expect(delay).toBe(1_000);
         expect(sleep).toHaveBeenCalledWith(1_000);
      });

      it('clamps out-of-range random values instead of overshooting', async () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '1000';
         const sleep = jest.fn<(ms: number) => Promise<void>>(
            async () => undefined,
         );

         expect(
            await applyAutoResolveJitter({ random: () => 2, sleep }),
         ).toBe(1_000);
         expect(
            await applyAutoResolveJitter({ random: () => -1, sleep }),
         ).toBe(0);
      });

      it('respects a zero configuration without sleeping', async () => {
         process.env.AUTO_RESOLVE_JITTER_MS = '0';
         const sleep = jest.fn<(ms: number) => Promise<void>>(
            async () => undefined,
         );

         expect(await applyAutoResolveJitter({ random: () => 1, sleep })).toBe(
            0,
         );
         expect(sleep).not.toHaveBeenCalled();
      });
   });
});
