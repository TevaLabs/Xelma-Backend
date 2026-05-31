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
import sorobanService from '../services/soroban.service';
import { toDecimal } from '../utils/decimal.util';

const shouldRunDbTests =
   process.env.RUN_DB_TESTS === 'true' ||
   process.env.CI === 'true' ||
   (global as any).hasDb;

jest.mock('../services/soroban.service', () => {
   return {
      __esModule: true,
      default: {
         resolveRound: jest.fn(() => Promise.resolve()),
         ensureInitialized: jest.fn(),
      },
   };
});

const describeDb = shouldRunDbTests ? describe : describe.skip;

describeDb('Resolution Service - Transactional & Concurrency Tests', () => {
   let testRound: any;
   let users: any[] = [];

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

      jest.clearAllMocks();
   });

   afterAll(async () => {
      await prisma.prediction.deleteMany({});
      await prisma.round.deleteMany({});
      await prisma.user.deleteMany({
         where: { id: { in: users.map(u => u.id) } },
      });
      await prisma.$disconnect();
   });

   describe('Transactional Integrity', () => {
      it('should resolve round atomically with all payout updates', async () => {
         const finalPrice = 105; // Price went UP

         const result = await resolutionService.resolveRound(
            testRound.id,
            finalPrice
         );

         expect(result.outcome).toBe('UPDATED');
         expect(result.round.status).toBe('RESOLVED');
         expect(result.round.endPrice).toBe(finalPrice);

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
         expect(result1.outcome).toBe('UPDATED');

         // Second resolution attempt
         const result2 = await resolutionService.resolveRound(
            testRound.id,
            finalPrice
         );
         expect(result2.outcome).toBe('ALREADY_RESOLVED');

         // Verify predictions weren't updated twice
         const predictions = await prisma.prediction.findMany({
            where: { roundId: testRound.id },
         });

         // Count winners
         const winners = predictions.filter(p => p.won === true);
         expect(winners.length).toBe(1); // Only 1 user bet UP
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
            expect(winner.payout).toBeGreaterThan(winner.amount);
         }

         // Verify losers have 0 payout
         const losers = predictions.filter(
            p => p.side === 'DOWN' && p.won === false
         );
         for (const loser of losers) {
            expect(loser.payout).toBe(0);
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
         expect(predictions.every(p => p.payout === p.amount)).toBe(true);
      });
   });

   describe('Error Handling', () => {
      it('should handle non-existent round gracefully', async () => {
         const result = await resolutionService.resolveRound(
            'non-existent-id',
            105
         );
         expect(result.outcome).toBe('NO_OP');
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
         expect(result.outcome).toBe('NO_OP');

         await prisma.round.delete({ where: { id: activeRound.id } });
      });
   });
});
