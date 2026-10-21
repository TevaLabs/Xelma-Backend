// The money path only aborts on a Soroban failure when the fail-closed
// policy is active, so the suite opts into it before the config is loaded.
process.env.SOROBAN_FAIL_CLOSED = 'true';

import {
   describe,
   it,
   expect,
   beforeAll,
   afterAll,
   beforeEach,
   jest,
} from '@jest/globals';
import { prisma } from '../lib/prisma';
import resolutionService from '../services/resolution.service';
import { RoundLifecycleOutcome } from '../types/round.types';
import sorobanService from '../services/soroban.service';
import { toDecimal } from '../utils/decimal.util';

const shouldRunDbTests =
   process.env.RUN_DB_TESTS === 'true' ||
   process.env.CI === 'true' ||
   (global as any).hasDb;

jest.mock('../services/soroban.service', () => {
   const { default: config } = jest.requireActual('../config');
   return {
      __esModule: true,
      default: {
         resolveRound: jest.fn(() => Promise.resolve()),
         ensureInitialized: jest.fn(),
         // Mirror the real policy: the money path aborts when fail-closed is
         // active and proceeds with a database-only fallback otherwise.
         applyMoneyPathFailure: jest.fn((_operation: string, error: unknown) => {
            if (config.soroban.failClosed) {
               throw error instanceof Error ? error : new Error(String(error));
            }
         }),
      },
   };
});

const describeDb = shouldRunDbTests ? describe : describe.skip;

describeDb('Resolution Service - Transactional & Concurrency Tests', () => {
   let testRound: any;
   let users: any[] = [];
   const createdRoundIds: string[] = [];

   beforeAll(async () => {
      if (shouldRunDbTests) {
         try {
            await prisma.$queryRaw`SELECT 1`;
         } catch (error) {
            console.error(
               'Database connectivity check failed:',
               error instanceof Error ? error.message : error
            );
            throw new Error(
               'Database unavailable for integration tests. Ensure DATABASE_URL is configured and database is running.'
            );
         }
      }

      // Create test users
      for (let i = 0; i < 3; i++) {
         const user = await prisma.user.create({
            data: {
               walletAddress: `G_RESOLUTION_TEST_${i}_${Math.random().toString(36).substring(7)}`,
               virtualBalance: 10000,
            },
         });
         users.push(user);
      }
   });

   beforeEach(async () => {
      // Create a fresh round for each test
      testRound = await prisma.round.create({
         data: {
            mode: 'UP_DOWN',
            status: 'LOCKED',
            startPrice: 100,
            startTime: new Date(),
            endTime: new Date(Date.now() + 3600000),
            poolUp: 0,
            poolDown: 0,
         },
      });

      // Create predictions for each user
      for (let i = 0; i < users.length; i++) {
         const side = i % 2 === 0 ? 'UP' : 'DOWN';
         const amount = 100;

         await prisma.prediction.create({
            data: {
               userId: users[i].id,
               roundId: testRound.id,
               side,
               amount,
               chainStatus: 'NOT_REQUIRED',
            },
         });

         // Update round pools
         await prisma.round.update({
            where: { id: testRound.id },
            data: {
               poolUp: side === 'UP' ? { increment: amount } : undefined,
               poolDown: side === 'DOWN' ? { increment: amount } : undefined,
            },
         });

         // Deduct from user balance
         await prisma.user.update({
            where: { id: users[i].id },
            data: { virtualBalance: { decrement: amount } },
         });
      }

      createdRoundIds.push(testRound.id);

      jest.clearAllMocks();
   });

   afterAll(async () => {
      // The integration database is shared by every suite, so only this
      // suite's rows are removed.
      await prisma.prediction.deleteMany({
         where: { userId: { in: users.map(u => u.id) } },
      });
      await prisma.round.deleteMany({ where: { id: { in: createdRoundIds } } });
      await prisma.user.deleteMany({
         where: { id: { in: users.map(u => u.id) } },
      });
   });

   describe('Transactional Integrity', () => {
      it('should resolve round atomically with all payout updates', async () => {
         const finalPrice = 105; // Price went UP

         const result = await resolutionService.resolveRound(
            testRound.id,
            finalPrice
         );

         expect(result.outcome).toBe(RoundLifecycleOutcome.UPDATED);
         expect(result.round.status).toBe('RESOLVED');
         expect(Number(result.round.endPrice)).toBe(finalPrice);

         // Verify all predictions were updated
         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         expect(predictions.length).toBe(3);
         expect(predictions.every(p => p.won !== undefined)).toBe(true);

         // Verify user balances were updated
         const updatedUsers = await prisma.user.findMany({
            where: { id: { in: users.map(u => u.id) } },
         });

         // Winners should have balance > 10000 - 100 (original - bet)
         const winners = updatedUsers.filter(u => u.virtualBalance > 9900);
         expect(winners.length).toBeGreaterThan(0);
      });

      it('should prevent duplicate resolution of same round', async () => {
         const finalPrice = 105;

         // First resolution
         const result1 = await resolutionService.resolveRound(
            testRound.id,
            finalPrice
         );
         expect(result1.outcome).toBe(RoundLifecycleOutcome.UPDATED);

         // Second resolution attempt
         const result2 = await resolutionService.resolveRound(
            testRound.id,
            finalPrice
         );
         expect(result2.outcome).toBe(RoundLifecycleOutcome.ALREADY_RESOLVED);

         // Verify predictions weren't updated twice
         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         // Count winners — the fixture has two UP bets and one DOWN bet.
         const winners = predictions.filter(p => p.won === true);
         expect(winners.length).toBe(2);
      });

      it('should rollback all changes if Soroban call fails', async () => {
         (sorobanService.resolveRound as any).mockRejectedValueOnce(
            new Error('Soroban Network Error')
         );

         const initialRound = await prisma.round.findUnique({
            where: { id: testRound.id },
         });
         const initialPredictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         await expect(
            resolutionService.resolveRound(testRound.id, 105)
         ).rejects.toThrow('Soroban Network Error');

         // Verify round status unchanged
         const updatedRound = await prisma.round.findUnique({
            where: { id: testRound.id },
         });
         expect(updatedRound!.status).toBe(initialRound!.status);

         // Verify predictions unchanged
         const updatedPredictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         expect(
            updatedPredictions.every(
               (p, i) => p.won === initialPredictions[i].won
            )
         ).toBe(true);
      });

      it('should handle concurrent resolution attempts safely', async () => {
         const finalPrice = 105;

         // Simulate concurrent resolution calls
         const results = await Promise.allSettled([
            resolutionService.resolveRound(testRound.id, finalPrice),
            resolutionService.resolveRound(testRound.id, finalPrice),
            resolutionService.resolveRound(testRound.id, finalPrice),
         ]);

         // First should succeed, others should be already resolved
         const successCount = results.filter(
            r => r.status === 'fulfilled'
         ).length;
         expect(successCount).toBeGreaterThanOrEqual(1);

         // Verify round is resolved exactly once
         const round = await prisma.round.findUnique({
            where: { id: testRound.id },
         });
         expect(round!.status).toBe('RESOLVED');

         // Verify predictions have correct payout counts
         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         // Each prediction should have exactly one payout value
         expect(predictions.every(p => p.payout !== null)).toBe(true);
      });

      it('should correctly distribute payouts to winners', async () => {
         const finalPrice = 105; // Price went UP

         await resolutionService.resolveRound(testRound.id, finalPrice);

         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
            include: { user: true },
         });

         // Find winners (those who bet UP)
         const winners = predictions.filter(
            p => p.side === 'UP' && p.won === true
         );
         expect(winners.length).toBeGreaterThan(0);

         // Verify winners have payouts > their original bet
         for (const winner of winners) {
            expect(Number(winner.payout)).toBeGreaterThan(Number(winner.amount));
         }

         // Verify losers have 0 payout
         const losers = predictions.filter(
            p => p.side === 'DOWN' && p.won === false
         );
         for (const loser of losers) {
            expect(Number(loser.payout)).toBe(0);
         }
      });

      it('should handle refund scenario when price unchanged', async () => {
         const finalPrice = 100; // Price unchanged

         await resolutionService.resolveRound(testRound.id, finalPrice);

         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         // All predictions should be refunded (won = null, payout = original amount)
         expect(predictions.every(p => p.won === null)).toBe(true);
         expect(
            predictions.every(p => Number(p.payout) === Number(p.amount))
         ).toBe(true);
      });
   });

   describe('Error Handling', () => {
      it('should handle non-existent round gracefully', async () => {
         const result = await resolutionService.resolveRound(
            'non-existent-id',
            105
         );
         expect(result.outcome).toBe(RoundLifecycleOutcome.NO_OP);
      });

      it('should handle round in invalid status', async () => {
         // Create a round in ACTIVE status (not LOCKED or RESOLVED)
         const activeRound = await prisma.round.create({
            data: {
               mode: 'UP_DOWN',
               status: 'ACTIVE',
               startPrice: 100,
               startTime: new Date(),
               endTime: new Date(Date.now() + 3600000),
               poolUp: 0,
               poolDown: 0,
            },
         });

         const result = await resolutionService.resolveRound(
            activeRound.id,
            105
         );
         expect(result.outcome).toBe(RoundLifecycleOutcome.NO_OP);

         await prisma.round.delete({ where: { id: activeRound.id } });
      });
   });
});
