import { PrismaClient, GameMode, RoundStatus } from '@prisma/client';
import sorobanService from './soroban.service';
import websocketService from './websocket.service';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export class RoundService {
    /**
     * Starts a new prediction round
     */
    async startRound(
        mode: 'UP_DOWN' | 'LEGENDS',
        startPrice: number,
        durationMinutes: number
    ): Promise<any> {
        try {
            const gameMode = mode === 'UP_DOWN' ? GameMode.UP_DOWN : GameMode.LEGENDS;
            const startTime = new Date();
            const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

            let sorobanRoundId: string | null = null;

            // Mode 0 (UP_DOWN): Create round on Soroban contract
            if (mode === 'UP_DOWN') {
                // Convert duration to ledgers (~5 seconds per ledger)
                const durationLedgers = Math.floor((durationMinutes * 60) / 5);
                sorobanRoundId = await sorobanService.createRound(startPrice, durationLedgers);
            }

            // Mode 1 (LEGENDS): Define price ranges
            let priceRanges = null;
            if (mode === 'LEGENDS') {
                // Create 5 price ranges around the current price
                const rangeWidth = startPrice * 0.05; // 5% range width
                priceRanges = [
                    { min: startPrice - rangeWidth * 2, max: startPrice - rangeWidth, pool: 0 },
                    { min: startPrice - rangeWidth, max: startPrice, pool: 0 },
                    { min: startPrice, max: startPrice + rangeWidth, pool: 0 },
                    { min: startPrice + rangeWidth, max: startPrice + rangeWidth * 2, pool: 0 },
                    { min: startPrice + rangeWidth * 2, max: startPrice + rangeWidth * 3, pool: 0 },
                ];
            }

            // Create round in database
            const round = await prisma.round.create({
                data: {
                    mode: gameMode,
                    status: RoundStatus.ACTIVE,
                    startTime,
                    endTime,
                    startPrice,
                    sorobanRoundId,
                    priceRanges: priceRanges as any,
                },
            });

            logger.info(`Round created: ${round.id}, mode=${mode}, sorobanId=${sorobanRoundId}`);

            return round;
        } catch (error) {
            logger.error('Failed to start round:', error);
            throw error;
        }
    }

    /**
     * Gets a round by ID
     */
    async getRound(roundId: string): Promise<any> {
        try {
            const round = await prisma.round.findUnique({
                where: { id: roundId },
                include: {
                    predictions: {
                        include: {
                            user: {
                                select: {
                                    id: true,
                                    walletAddress: true,
                                },
                            },
                        },
                    },
                },
            });

            return round;
        } catch (error) {
            logger.error('Failed to get round:', error);
            throw error;
        }
    }

    /**
     * Gets all active rounds
     */
    async getActiveRounds(): Promise<any[]> {
        try {
            const rounds = await prisma.round.findMany({
                where: {
                    status: RoundStatus.ACTIVE,
                },
                orderBy: {
                    startTime: 'desc',
                },
            });

            return rounds;
        } catch (error) {
            logger.error('Failed to get active rounds:', error);
            throw error;
        }
    }

    /**
     * Locks a round (no more predictions allowed)
     */
    async lockRound(roundId: string): Promise<void> {
        try {
            await prisma.round.update({
                where: { id: roundId },
                data: { status: RoundStatus.LOCKED },
            });

            logger.info(`Round locked: ${roundId}`);
        } catch (error) {
            logger.error('Failed to lock round:', error);
            throw error;
        }
    }

    /**
     * Checks if a round should be auto-locked based on time
     */
    async autoLockExpiredRounds(): Promise<void> {
        try {
            const now = new Date();

            const expiredRounds = await prisma.round.findMany({
                where: {
                    status: RoundStatus.ACTIVE,
                    endTime: {
                        lte: now,
                    },
                },
            });

            for (const round of expiredRounds) {
                await this.lockRound(round.id);
            }

            if (expiredRounds.length > 0) {
                logger.info(`Auto-locked ${expiredRounds.length} expired rounds`);
            }
        } catch (error) {
            logger.error('Failed to auto-lock expired rounds:', error);
        }
    }

    /**
     * Gets historical rounds with pagination and aggregate stats
     */
    async getRoundsHistory(options: {
        limit?: number;
        offset?: number;
        mode?: 'UP_DOWN' | 'LEGENDS';
        status?: 'RESOLVED' | 'CANCELLED';
    }): Promise<{
        rounds: any[];
        total: number;
        limit: number;
        offset: number;
    }> {
        try {
            const limit = Math.min(options.limit ?? 20, 100);
            const offset = options.offset ?? 0;

            // Build where clause for historical rounds (RESOLVED or CANCELLED)
            const where: any = {
                status: {
                    in: [RoundStatus.RESOLVED, RoundStatus.CANCELLED],
                },
            };

            // Apply optional filters
            if (options.mode) {
                where.mode = options.mode === 'UP_DOWN' ? GameMode.UP_DOWN : GameMode.LEGENDS;
            }

            if (options.status) {
                where.status = options.status === 'RESOLVED' ? RoundStatus.RESOLVED : RoundStatus.CANCELLED;
            }

            // Get total count for pagination
            const total = await prisma.round.count({ where });

            // Get rounds with predictions for aggregate stats
            const rounds = await prisma.round.findMany({
                where,
                orderBy: {
                    resolvedAt: 'desc',
                },
                skip: offset,
                take: limit,
                include: {
                    predictions: {
                        select: {
                            amount: true,
                            won: true,
                        },
                    },
                },
            });

            // Transform rounds to include aggregate stats
            const roundsWithStats = rounds.map((round: any) => {
                const totalPredictions = round.predictions.length;
                const totalPool = round.predictions.reduce((sum: number, p: any) => sum + p.amount, 0);
                const winnerCount = round.predictions.filter((p: any) => p.won === true).length;

                // Remove predictions array and add aggregate stats
                const { predictions, ...roundData } = round;

                return {
                    ...roundData,
                    totalPredictions,
                    totalPool: totalPool.toFixed(2),
                    winnerCount,
                };
            });

            return {
                rounds: roundsWithStats,
                total,
                limit,
                offset,
            };
        } catch (error) {
            logger.error('Failed to get rounds history:', error);
            throw error;
        }
    }
}

export default new RoundService();
