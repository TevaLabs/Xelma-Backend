import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';

// Mock Prisma
const mockPredictions: any[] = [];
const mockRounds: any[] = [];
const mockUsers: any[] = [];

jest.mock('../lib/prisma', () => ({
    prisma: {
        prediction: {
            deleteMany: jest.fn(async () => { mockPredictions.length = 0; }),
            createMany: jest.fn(async ({ data }: any) => {
                data.forEach((p: any) => mockPredictions.push({
                    ...p,
                    id: 'pred-' + Math.random().toString(),
                    amount: new Decimal(p.amount)
                }));
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const p = mockPredictions.find(p => p.roundId === where.roundId_userId?.roundId && p.userId === where.roundId_userId?.userId);
                return p ? { ...p, amount: new Decimal(p.amount), payout: p.payout ? new Decimal(p.payout) : null } : null;
            }),
            findMany: jest.fn(async ({ where }: any) => {
                return mockPredictions
                    .filter(p => p.roundId === where.roundId)
                    .map(p => ({ ...p, amount: new Decimal(p.amount), payout: p.payout ? new Decimal(p.payout) : null }));
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const p = mockPredictions.find(p => p.id === where.id);
                if (p) {
                    Object.assign(p, data);
                    if (data.payout !== undefined) p.payout = data.payout === null ? null : new Decimal(data.payout);
                }
                return p;
            }),
        },
        round: {
            deleteMany: jest.fn(async () => { mockRounds.length = 0; }),
            create: jest.fn(async ({ data }: any) => {
                const r = {
                    ...data,
                    id: 'test-round-' + Math.random(),
                    startPrice: new Decimal(data.startPrice),
                    poolUp: new Decimal(data.poolUp || 0),
                    poolDown: new Decimal(data.poolDown || 0)
                };
                mockRounds.push(r);
                return r;
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const r = mockRounds.find(r => r.id === where.id);
                if (!r) return null;
                const predictions = mockPredictions
                    .filter(p => p.roundId === r.id)
                    .map(p => ({ ...p, amount: new Decimal(p.amount) }));
                return {
                    ...r,
                    startPrice: new Decimal(r.startPrice),
                    poolUp: new Decimal(r.poolUp),
                    poolDown: new Decimal(r.poolDown),
                    predictions
                };
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const r = mockRounds.find(r => r.id === where.id);
                if (r) {
                    Object.assign(r, data);
                    if (data.poolUp !== undefined) r.poolUp = new Decimal(data.poolUp);
                    if (data.poolDown !== undefined) r.poolDown = new Decimal(data.poolDown);
                    if (data.endPrice !== undefined) r.endPrice = new Decimal(data.endPrice);
                }
                return r;
            }),
        },
        user: {
            deleteMany: jest.fn(async () => { mockUsers.length = 0; }),
            create: jest.fn(async ({ data }: any) => {
                const u = {
                    ...data,
                    id: 'user-' + Math.random(),
                    virtualBalance: new Decimal(data.virtualBalance)
                };
                mockUsers.push(u);
                return u;
            }),
            findUnique: jest.fn(async ({ where }: any) => {
                const u = mockUsers.find(u => u.id === where.id);
                return u ? { ...u, virtualBalance: new Decimal(u.virtualBalance) } : null;
            }),
            update: jest.fn(async ({ where, data }: any) => {
                const u = mockUsers.find(u => u.id === where.id);
                if (u) {
                    if (data.virtualBalance && data.virtualBalance.increment) {
                        u.virtualBalance = new Decimal(u.virtualBalance).plus(new Decimal(data.virtualBalance.increment));
                    } else if (data.virtualBalance !== undefined) {
                        u.virtualBalance = new Decimal(data.virtualBalance);
                    }
                }
                return u;
            }),
        },
        $disconnect: jest.fn(async () => { }),
    }
}));

import { prisma } from '../lib/prisma';
import resolutionService from '../services/resolution.service';

// Mock Soroban Service
jest.mock('../services/soroban.service', () => ({
    resolveRound: jest.fn(async () => { }),
    placeBet: jest.fn(async () => { }),
    createRound: jest.fn(async () => 'soroban-round-id'),
}));

// Mock Notification Service
jest.mock('../services/notification.service', () => ({
    createNotification: jest.fn(async () => ({ id: 'notif-id' })),
}));

// Mock WebSocket Service
jest.mock('../services/websocket.service', () => ({
    emitNotification: jest.fn(),
}));

describe('Monetary Precision and Deterministic Payouts', () => {
    let userA: any;
    let userB: any;
    let userC: any;

    beforeAll(async () => {
        // Cleanup
        await prisma.prediction.deleteMany({});
        await prisma.round.deleteMany({});
        await prisma.user.deleteMany({});

        // Create users
        userA = await prisma.user.create({
            data: { walletAddress: 'GA', virtualBalance: 1000.33333333 },
        });
        userB = await prisma.user.create({
            data: { walletAddress: 'GB', virtualBalance: 1000.33333333 },
        });
        userC = await prisma.user.create({
            data: { walletAddress: 'GC', virtualBalance: 1000.33333334 },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('should calculate payouts deterministically (Up/Down)', async () => {
        const round = await prisma.round.create({
            data: {
                mode: 'UP_DOWN',
                status: 'ACTIVE',
                startPrice: 100.0,
                startTime: new Date(),
                endTime: new Date(),
                poolUp: 20.66,
                poolDown: 10.34,
            },
        });

        await prisma.prediction.createMany({
            data: [
                { roundId: round.id, userId: userA.id, side: 'UP', amount: 10.33 },
                { roundId: round.id, userId: userB.id, side: 'UP', amount: 10.33 },
                { roundId: round.id, userId: userC.id, side: 'DOWN', amount: 10.34 },
            ],
        });

        await resolutionService.resolveRound(round.id, 105.0);

        const predictions = await prisma.prediction.findMany({ where: { roundId: round.id } });
        const pA = predictions.find(p => p.userId === userA.id);
        const pB = predictions.find(p => p.userId === userB.id);

        // Share = (10.33 / 20.66) * 10.34 = 5.17
        // Payout = 10.33 + 5.17 = 15.50
        expect(pA!.payout!.toFixed(8)).toBe('15.50000000');
        expect(pB!.payout!.toFixed(8)).toBe('15.50000000');

        const uA = await prisma.user.findUnique({ where: { id: userA.id } });
        expect(uA!.virtualBalance.toFixed(8)).toBe('1015.83333333');
    });

    it('should handle repeating decimals (Repeating)', async () => {
        const round = await prisma.round.create({
            data: {
                mode: 'UP_DOWN',
                status: 'ACTIVE',
                startPrice: 100.0,
                startTime: new Date(),
                endTime: new Date(),
                poolUp: 30,
                poolDown: 10,
            },
        });

        await prisma.prediction.createMany({
            data: [
                { roundId: round.id, userId: userA.id, side: 'UP', amount: 10 },
                { roundId: round.id, userId: userB.id, side: 'UP', amount: 10 },
                { roundId: round.id, userId: userC.id, side: 'UP', amount: 10 },
            ],
        });

        await resolutionService.resolveRound(round.id, 110.0);

        const predictions = await prisma.prediction.findMany({ where: { roundId: round.id, won: true } });
        for (const p of predictions) {
            expect(p.payout!.toFixed(8)).toBe('13.33333333');
        }
    });
});
