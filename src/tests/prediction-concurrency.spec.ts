import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { prisma } from '../lib/prisma';
import predictionService from '../services/prediction.service';
import sorobanService from '../services/soroban.service';
import { toDecimal } from '../utils/decimal.util';

// Mock soroban service - we use jest.mock to replace the module with a mock object
jest.mock('../services/soroban.service', () => {
    return {
        __esModule: true,
        default: {
            placeBet: jest.fn(() => Promise.resolve()),
            ensureInitialized: jest.fn(),
        }
    };
});

describe('Prediction Service - Transactional & Concurrency Tests', () => {
    let user: any;
    let testRound: any;

    beforeAll(async () => {
        user = await prisma.user.create({
            data: {
                walletAddress: 'G_CONCURRENCY_TEST_' + Math.random().toString(36).substring(7),
                virtualBalance: 1000,
            },
        });
    });

    beforeEach(async () => {
        // Create a fresh round for each test
        testRound = await prisma.round.create({
            data: {
                mode: 'UP_DOWN',
                status: 'ACTIVE',
                startPrice: 0.5,
                startTime: new Date(),
                endTime: new Date(Date.now() + 3600000),
                poolUp: 0,
                poolDown: 0,
            },
        });

        // Reset user balance to 1000
        await prisma.user.update({
            where: { id: user.id },
            data: { virtualBalance: 1000 }
        });

        jest.clearAllMocks();
    });

    afterAll(async () => {
        await prisma.prediction.deleteMany({});
        await prisma.round.deleteMany({});
        await prisma.user.deleteMany({
            where: { id: user.id }
        });
        await prisma.$disconnect();
    });

    describe('Transactional Integrity', () => {
        it('should rollback all DB changes if Soroban call fails', async () => {
            // Mock Soroban to fail
            (sorobanService.placeBet as any).mockRejectedValueOnce(new Error('Soroban Network Error'));

            const initialUser = await prisma.user.findUnique({ where: { id: user.id } });
            const initialRound = await prisma.round.findUnique({ where: { id: testRound.id } });

            await expect(
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP')
            ).rejects.toThrow('Soroban Network Error');

            // Verify no prediction created
            const predictionCount = await prisma.prediction.count({
                where: { userId: user.id, roundId: testRound.id }
            });
            expect(predictionCount).toBe(0);

            // Verify balance NOT deducted
            const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
            expect(updatedUser!.virtualBalance.toString()).toBe(initialUser!.virtualBalance.toString());

            // Verify pool NOT updated
            const updatedRound = await prisma.round.findUnique({ where: { id: testRound.id } });
            expect(updatedRound!.poolUp.toString()).toBe(initialRound!.poolUp.toString());
        });
    });

    describe('Concurrency Handling', () => {
        it('should refuse duplicate predictions from same user even if submitted simultaneously', async () => {
            // Launch 5 simultaneous requests
            const results = await Promise.allSettled([
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP'),
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP'),
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP'),
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP'),
                predictionService.submitPrediction(user.id, testRound.id, 100, 'UP'),
            ]);

            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter(r => r.status === 'rejected');

            // Only 1 should succeed due to @@unique([roundId, userId])
            expect(fulfilled.length).toBe(1);
            expect(rejected.length).toBe(4);

            // Verify correct balance deduction (exactly 100)
            const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(updatedUser!.virtualBalance)).toBe(900);

            // Verify exacty one prediction exists
            const predictions = await prisma.prediction.findMany({
                where: { userId: user.id, roundId: testRound.id }
            });
            expect(predictions.length).toBe(1);
        });

        it('should prevent balance overdraft under concurrent load', async () => {
            // User has 1000. Try to spend 300 x 5 = 1500.
            // Only 3 should succeed (900 total), 2 should fail.

            // We need multiple rounds because one user can only bet once per round.
            // Or we can use multiple users. Let's create more users.
            const users = await Promise.all([
                prisma.user.create({ data: { walletAddress: 'U1_' + Math.random(), virtualBalance: 100 } }),
                prisma.user.create({ data: { walletAddress: 'U2_' + Math.random(), virtualBalance: 100 } }),
                prisma.user.create({ data: { walletAddress: 'U3_' + Math.random(), virtualBalance: 100 } }),
            ]);

            // Actually, let's test a single user across multiple rounds if we want to test same-user lock,
            // but the requirement is "balance integrity". 
            // Let's test a single user with low balance trying to bet on DIFFERENT rounds concurrently.

            const rounds = await Promise.all([
                prisma.round.create({ data: { mode: 'UP_DOWN', status: 'ACTIVE', startPrice: 1, startTime: new Date(), endTime: new Date(Date.now() + 100000), poolUp: 0, poolDown: 0 } }),
                prisma.round.create({ data: { mode: 'UP_DOWN', status: 'ACTIVE', startPrice: 1, startTime: new Date(), endTime: new Date(Date.now() + 100000), poolUp: 0, poolDown: 0 } }),
                prisma.round.create({ data: { mode: 'UP_DOWN', status: 'ACTIVE', startPrice: 1, startTime: new Date(), endTime: new Date(Date.now() + 100000), poolUp: 0, poolDown: 0 } }),
            ]);

            // Reduce user balance to 150
            await prisma.user.update({ where: { id: user.id }, data: { virtualBalance: 150 } });

            // Try to place three 100-amount bets.
            const results = await Promise.allSettled([
                predictionService.submitPrediction(user.id, rounds[0].id, 100, 'UP'),
                predictionService.submitPrediction(user.id, rounds[1].id, 100, 'UP'),
                predictionService.submitPrediction(user.id, rounds[2].id, 100, 'UP'),
            ]);

            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter(r => r.status === 'rejected') as any[];

            // Only 1 should succeed (100 < 150, but 200 > 150)
            expect(fulfilled.length).toBe(1);
            expect(rejected.length).toBe(2);
            expect(rejected.some(r => r.reason.message === 'Insufficient balance')).toBe(true);

            // Verify balance is exactly 50
            const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(updatedUser!.virtualBalance)).toBe(50);

            // Cleanup extra rounds and users
            await prisma.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
            await prisma.round.deleteMany({ where: { id: { in: rounds.map(r => r.id) } } });
        });
    });
});
