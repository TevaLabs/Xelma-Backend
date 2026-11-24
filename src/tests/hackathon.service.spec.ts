import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';

// Declared with `var` and assigned inside the hoisted prisma mock factory so
// Jest's mock hoisting cannot place the factory before initialisation (TDZ).
var mockMockLeaderboard: Map<string, any>;
var mockMockRounds: Map<string, any>;

const mockPools: Map<string, { poolUp: Decimal; poolDown: Decimal }> = new Map();
const mockUsers: Map<string, Decimal> = new Map();
const mockRounds: Map<string, { mode: string; status: string }> = new Map();

jest.mock('../lib/prisma', () => {
    mockMockLeaderboard = new Map();
    mockMockRounds = new Map();
    return {
    prisma: {
        $transaction: jest.fn(async (fn: any) => {
            const tx = {
                user: {
                    findUnique: jest.fn(async ({ where }: any) => {
                        const balance = mockUsers.get(where.id);
                        if (!balance) return null;
                        return { id: where.id, virtualBalance: balance, walletAddress: 'mock-address' };
                    }),
                    update: jest.fn(async ({ where, data }: any) => {
                        const balance = mockUsers.get(where.id);
                        if (balance === undefined) throw Object.assign(new Error('Not found'), { code: 'P2025' });
                        if (data.virtualBalance && data.virtualBalance.decrement) {
                            const newBalance = balance.sub(new Decimal(data.virtualBalance.decrement));
                            if (newBalance.lt(0)) throw Object.assign(new Error('Insufficient'), { code: 'P2025' });
                            mockUsers.set(where.id, newBalance);
                            return { ...(await tx.user.findUnique({ where })), virtualBalance: newBalance };
                        }
                        return { id: where.id, virtualBalance: balance };
                    }),
                },
                round: {
                    findUnique: jest.fn(async ({ where }: any) => {
                        const r = mockRounds.get(where.id);
                        const pools = mockPools.get(where.id);
                        if (!r) return null;
                        return { ...r, poolUp: pools!.poolUp, poolDown: pools!.poolDown };
                    }),
                    update: jest.fn(async ({ where, data }: any) => {
                        const pools = mockPools.get(where.id);
                        if (data.poolUp && data.poolUp.increment) {
                            pools!.poolUp = pools!.poolUp.plus(new Decimal(data.poolUp.increment));
                        }
                        if (data.poolDown && data.poolDown.increment) {
                            pools!.poolDown = pools!.poolDown.plus(new Decimal(data.poolDown.increment));
                        }
                        return { ...mockRounds.get(where.id), poolUp: pools!.poolUp, poolDown: pools!.poolDown };
                    }),
                },
                // Mock/hackathon (address-based) bet path collections.
                mockLeaderboard: {
                    findUnique: jest.fn(async ({ where }: any) => mockMockLeaderboard.get(where.address) ?? null),
                    create: jest.fn(async ({ data }: any) => {
                        const row = { ...data };
                        mockMockLeaderboard.set(data.address, row);
                        return row;
                    }),
                    update: jest.fn(async ({ where, data }: any) => {
                        const row = mockMockLeaderboard.get(where.address) ?? {};
                        if (data.balance?.decrement !== undefined) {
                            row.balance = (row.balance ?? 1000) - data.balance.decrement;
                        }
                        mockMockLeaderboard.set(where.address, row);
                        return row;
                    }),
                },
                mockBet: {
                    create: jest.fn(async ({ data }: any) => ({ id: 'mock-bet', ...data })),
                },
                mockRound: {
                    findUnique: jest.fn(async ({ where }: any) => mockMockRounds.get(where.id) ?? null),
                    update: jest.fn(async ({ where, data }: any) => {
                        const row = mockMockRounds.get(where.id) ?? {};
                        if (data.totalPool?.increment !== undefined) row.totalPool = (row.totalPool ?? 0) + data.totalPool.increment;
                        if (data.predictionCount?.increment !== undefined) row.predictionCount = (row.predictionCount ?? 0) + data.predictionCount.increment;
                        if (data.poolUp?.increment !== undefined) row.poolUp = (row.poolUp ?? 0) + data.poolUp.increment;
                        if (data.poolDown?.increment !== undefined) row.poolDown = (row.poolDown ?? 0) + data.poolDown.increment;
                        mockMockRounds.set(where.id, row);
                        return row;
                    }),
                },
            };
            return await fn(tx);
        }),
    },
    };
});

jest.mock('../services/soroban.service', () => ({
    __esModule: true,
    default: {
        placeBet: jest.fn(() => Promise.resolve()),
        ensureInitialized: jest.fn(),
    },
}));

const mockEmitBetAccepted = jest.fn();
jest.mock('../services/websocket.service', () => ({
    __esModule: true,
    default: {
        emitBetAccepted: (...args: any[]) => mockEmitBetAccepted(...args),
    },
}));

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

import hackathonService from '../services/hackathon.service';
import { toDecimal, decEq, decGte } from '../utils/decimal.util';

describe('HackathonService - placeBet', () => {
    const userId = 'user-hack-test-1';
    const roundId = 'round-hack-test-1';

    beforeEach(() => {
        mockUsers.clear();
        mockPools.clear();
        mockRounds.clear();
        mockMockLeaderboard.clear();
        mockMockRounds.clear();

        mockUsers.set(userId, new Decimal(1000));
        mockPools.set(roundId, { poolUp: new Decimal(0), poolDown: new Decimal(0) });
        mockRounds.set(roundId, { mode: 'UP_DOWN', status: 'ACTIVE' });

        jest.clearAllMocks();
    });

    describe('Overdraft Rejection', () => {
        it('rejects a bet when balance is exactly zero', async () => {
            mockUsers.set(userId, new Decimal(0));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 1,
                    side: 'UP',
                }),
            ).rejects.toThrow('Insufficient balance');
        });

        it('rejects a bet when balance is less than the bet amount', async () => {
            mockUsers.set(userId, new Decimal(50));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 100,
                    side: 'UP',
                }),
            ).rejects.toThrow('Insufficient balance');
        });

        it('rejects a bet when balance is insufficient for a fractional amount', async () => {
            mockUsers.set(userId, new Decimal('0.00000001'));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 0.01,
                    side: 'DOWN',
                }),
            ).rejects.toThrow('Insufficient balance');
        });

        it('does not deduct balance when overdraft is rejected', async () => {
            mockUsers.set(userId, new Decimal(50));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 100,
                    side: 'UP',
                }),
            ).rejects.toThrow('Insufficient balance');

            const balance = mockUsers.get(userId)!;
            expect(decEq(balance, 50)).toBe(true);
        });

        it('does not update pool when overdraft is rejected', async () => {
            mockUsers.set(userId, new Decimal(50));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 100,
                    side: 'UP',
                }),
            ).rejects.toThrow('Insufficient balance');

            const pools = mockPools.get(roundId)!;
            expect(pools.poolUp.toNumber()).toBe(0);
            expect(pools.poolDown.toNumber()).toBe(0);
        });
    });

    describe('Pool Increments', () => {
        it('increments poolUp when betting UP', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 100,
                side: 'UP',
            });

            expect(result.side).toBe('UP');
            expect(decEq(result.amount, 100)).toBe(true);
            expect(decGte(result.poolUp, 100)).toBe(true);
            expect(result.poolDown.toNumber()).toBe(0);

            const pools = mockPools.get(roundId)!;
            expect(decEq(pools.poolUp, 100)).toBe(true);
            expect(pools.poolDown.toNumber()).toBe(0);
        });

        it('increments poolDown when betting DOWN', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 100,
                side: 'DOWN',
            });

            expect(result.side).toBe('DOWN');
            expect(decEq(result.amount, 100)).toBe(true);
            expect(result.poolUp.toNumber()).toBe(0);
            expect(decGte(result.poolDown, 100)).toBe(true);

            const pools = mockPools.get(roundId)!;
            expect(pools.poolUp.toNumber()).toBe(0);
            expect(decEq(pools.poolDown, 100)).toBe(true);
        });

        it('accumulates poolUp across multiple UP bets', async () => {
            const user2 = 'user-hack-test-2';
            mockUsers.set(user2, new Decimal(1000));

            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 50,
                side: 'UP',
            });

            await hackathonService.placeBet({
                userId: user2,
                roundId,
                amount: 75,
                side: 'UP',
            });

            const pools = mockPools.get(roundId)!;
            expect(decEq(pools.poolUp, 125)).toBe(true);
            expect(pools.poolDown.toNumber()).toBe(0);
        });

        it('accumulates poolDown across multiple DOWN bets', async () => {
            const user2 = 'user-hack-test-3';
            mockUsers.set(user2, new Decimal(1000));

            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 30,
                side: 'DOWN',
            });

            await hackathonService.placeBet({
                userId: user2,
                roundId,
                amount: 45,
                side: 'DOWN',
            });

            const pools = mockPools.get(roundId)!;
            expect(pools.poolUp.toNumber()).toBe(0);
            expect(decEq(pools.poolDown, 75)).toBe(true);
        });

        it('maintains separate poolUp and poolDown for mixed sides', async () => {
            const resultUp = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 100,
                side: 'UP',
            });

            expect(decEq(resultUp.poolUp, 100)).toBe(true);
            expect(resultUp.poolDown.toNumber()).toBe(0);

            const user2 = 'user-hack-test-4';
            mockUsers.set(user2, new Decimal(1000));

            const resultDown = await hackathonService.placeBet({
                userId: user2,
                roundId,
                amount: 50,
                side: 'DOWN',
            });

            expect(resultDown.poolUp.toNumber()).toBe(100);
            expect(decEq(resultDown.poolDown, 50)).toBe(true);

            const pools = mockPools.get(roundId)!;
            expect(decEq(pools.poolUp, 100)).toBe(true);
            expect(decEq(pools.poolDown, 50)).toBe(true);
        });

        it('pool totals equal sum of all bets on each side', async () => {
            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 10,
                side: 'UP',
            });

            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 20,
                side: 'UP',
            });

            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 30,
                side: 'UP',
            });

            const pools = mockPools.get(roundId)!;
            expect(decEq(pools.poolUp, 60)).toBe(true);
            expect(pools.poolDown.toNumber()).toBe(0);
        });
    });

    describe('Decimal Assertions', () => {
        it('returns Decimal instances for balance and pool values', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 100,
                side: 'UP',
            });

            expect(result.amount).toBeInstanceOf(Decimal);
            expect(result.newBalance).toBeInstanceOf(Decimal);
            expect(result.poolUp).toBeInstanceOf(Decimal);
            expect(result.poolDown).toBeInstanceOf(Decimal);
        });

        it('preserves full precision in balance deduction', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 0.12345678,
                side: 'UP',
            });

            expect(result.amount.toFixed(8)).toBe('0.12345678');
            expect(result.newBalance.toFixed(8)).toBe('999.87654322');
        });

        it('balances correctly after a bet using Decimal arithmetic', async () => {
            const betAmount = toDecimal(100);
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 100,
                side: 'UP',
            });

            const expectedBalance = toDecimal(1000).sub(betAmount);
            expect(decEq(result.newBalance, expectedBalance)).toBe(true);
        });

        it('handles very small amounts without precision loss', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 0.00000001,
                side: 'UP',
            });

            expect(result.amount.toFixed(8)).toBe('0.00000001');
            expect(decEq(result.poolUp, 0.00000001)).toBe(true);
        });

        it('handles fractional amounts that are prone to float drift', async () => {
            const result1 = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 0.1,
                side: 'UP',
            });

            expect(result1.amount.toFixed(8)).toBe('0.10000000');
            expect(decEq(result1.poolUp, 0.1)).toBe(true);

            const result2 = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 0.2,
                side: 'UP',
            });

            expect(result2.amount.toFixed(8)).toBe('0.20000000');
            expect(decEq(result2.poolUp, 0.3)).toBe(true);
        });

        it('deducts balance correctly using Decimal arithmetic', async () => {
            const result = await hackathonService.placeBet({
                userId,
                roundId,
                amount: 33.33333333,
                side: 'UP',
            });

            expect(result.newBalance.toFixed(8)).toBe('966.66666667');
        });
    });

    describe('Round Validation', () => {
        it('rejects a bet when round does not exist', async () => {
            mockRounds.clear();

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId: 'nonexistent',
                    amount: 10,
                    side: 'UP',
                }),
            ).rejects.toThrow('Round not found');
        });

        it('rejects a bet when round is not active', async () => {
            mockRounds.set(roundId, { mode: 'UP_DOWN', status: 'RESOLVED' });

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 10,
                    side: 'UP',
                }),
            ).rejects.toThrow('Round is not active');
        });
    });

    describe('bet:accepted socket parity (issue #986)', () => {
        it('emits bet:accepted with the full-mode payload shape after a transactional bet', async () => {
            await hackathonService.placeBet({
                userId,
                roundId,
                amount: 25,
                side: 'UP',
            });

            expect(mockEmitBetAccepted).toHaveBeenCalledTimes(1);
            expect(mockEmitBetAccepted).toHaveBeenCalledWith({
                roundId,
                address: 'mock-address',
                amount: '25',
                side: 'UP',
                mode: 'UP_DOWN',
                state: 'accepted',
            });
        });

        it('does not emit bet:accepted when a bet is rejected', async () => {
            mockUsers.set(userId, new Decimal(0));

            await expect(
                hackathonService.placeBet({
                    userId,
                    roundId,
                    amount: 10,
                    side: 'UP',
                }),
            ).rejects.toThrow('Insufficient balance');

            expect(mockEmitBetAccepted).not.toHaveBeenCalled();
        });

        it('emits a stub bet:accepted for an address-based mock bet', async () => {
            mockMockRounds.set(roundId, { mode: 'updown', status: 'live' });

            await hackathonService.placeBet(
                roundId,
                'GMOCKADDRESS',
                12,
                'DOWN',
            );

            expect(mockEmitBetAccepted).toHaveBeenCalledTimes(1);
            expect(mockEmitBetAccepted).toHaveBeenCalledWith({
                roundId,
                address: 'GMOCKADDRESS',
                amount: '12',
                side: 'DOWN',
                mode: 'UP_DOWN',
                state: 'stub',
            });
        });

        it('maps a precision mock bet to PRECISION mode', async () => {
            mockMockRounds.set(roundId, { mode: 'precision', status: 'live' });

            await hackathonService.placeBet(
                roundId,
                'GMOCKADDRESS',
                7,
                undefined,
                0.42,
            );

            expect(mockEmitBetAccepted).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: 'PRECISION',
                    state: 'stub',
                }),
            );
        });
    });
});