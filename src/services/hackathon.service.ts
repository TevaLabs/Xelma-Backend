import { toNumber, toDecimal } from '../utils/decimal.util';
import { prisma } from '../lib/prisma';
import { Decimal } from '@prisma/client/runtime/library';
import { BusinessRuleError, ErrorCode } from '../utils/errors';
import logger from '../utils/logger';

export interface PlaceBetInput {
  userId: string;
  roundId: string;
  amount: number;
  side: 'UP' | 'DOWN';
}

export interface BetResult {
  userId: string;
  roundId: string;
  amount: Decimal;
  side: 'UP' | 'DOWN';
  newBalance: Decimal;
  poolUp: Decimal;
  poolDown: Decimal;
}

export class HackathonService {
  async placeBet(input: PlaceBetInput): Promise<BetResult>;
  async placeBet(
    roundId: string,
    address: string,
    amount: number,
    side?: 'UP' | 'DOWN',
    predictedPrice?: number,
  ): Promise<void>;
  async placeBet(
    inputOrRoundId: PlaceBetInput | string,
    address?: string,
    amount?: number,
    side?: 'UP' | 'DOWN',
    predictedPrice?: number,
  ): Promise<BetResult | void> {
    if (typeof inputOrRoundId === 'string') {
      return this.placeMockBet(inputOrRoundId, address!, amount!, side, predictedPrice);
    }
    return this.placeTransactionalBet(inputOrRoundId);
  }

  private async placeTransactionalBet(input: PlaceBetInput): Promise<BetResult> {
    const { userId, roundId, amount, side } = input;
    const decimalAmount = toDecimal(amount);

    return prisma.$transaction(async (tx) => {
      const round = await tx.round.findUnique({
        where: { id: roundId },
      });

      if (!round) {
        throw new BusinessRuleError(
          'Round not found',
          ErrorCode.NOT_FOUND,
        );
      }

      if (round.status !== 'ACTIVE') {
        throw new BusinessRuleError(
          'Round is not active',
          ErrorCode.ROUND_NOT_ACTIVE,
        );
      }

      const user = await tx.user
        .update({
          where: {
            id: userId,
            virtualBalance: { gte: decimalAmount },
          },
          data: {
            virtualBalance: { decrement: decimalAmount },
          },
        })
        .catch((err: any) => {
          if (err.code === 'P2025') {
            throw new BusinessRuleError(
              'Insufficient balance',
              ErrorCode.INSUFFICIENT_FUNDS,
            );
          }
          throw err;
        });

      if (side === 'UP') {
        await tx.round.update({
          where: { id: roundId },
          data: { poolUp: { increment: decimalAmount } },
        });
      } else {
        await tx.round.update({
          where: { id: roundId },
          data: { poolDown: { increment: decimalAmount } },
        });
      }

      const updatedRound = await tx.round.findUnique({
        where: { id: roundId },
      });

      logger.info(
        `Hackathon bet placed: user=${userId}, round=${roundId}, side=${side}, amount=${toNumber(decimalAmount)}`,
      );

      return {
        userId,
        roundId,
        amount: decimalAmount,
        side,
        newBalance: user.virtualBalance,
        poolUp: updatedRound!.poolUp,
        poolDown: updatedRound!.poolDown,
      };
    });
  }

  async getRounds() {
    const rounds = await prisma.mockRound.findMany();
    return rounds.map(r => {
      if (r.mode === 'updown') {
        return {
          id: r.id,
          asset: r.asset,
          mode: r.mode,
          status: r.status,
          startPrice: r.startPrice,
          poolUp: r.poolUp,
          poolDown: r.poolDown,
          closesAt: r.closesAt,
        };
      }
      return {
        id: r.id,
        asset: r.asset,
        mode: r.mode,
        status: r.status,
        startPrice: r.startPrice,
        totalPool: r.totalPool,
        predictionCount: r.predictionCount,
        closesAt: r.closesAt,
      };
    });
  }

  async getLeaderboard() {
    const users = await (prisma as any).mockLeaderboard.findMany({ orderBy: { xp: 'desc' } });
    return users.slice(0, 10).map((u: any, index: number) => ({
      rank: index + 1,
      address: u.address,
      totalWins: u.totalWins,
      totalLosses: u.totalLosses,
      winStreak: u.winStreak,
      xp: u.xp,
      rankTitle: u.rankTitle,
    }));
  }

  async getUserStats(address: string) {
    const mockPrisma = prisma as any;
    const existing = await mockPrisma.mockLeaderboard.findUnique({ where: { address } });
    if (existing) {
      return {
        address: existing.address,
        balance: existing.balance,
        pendingWinnings: existing.pendingWinnings,
        totalWins: existing.totalWins,
        totalLosses: existing.totalLosses,
        currentStreak: existing.winStreak,
        xp: existing.xp,
        rankTitle: existing.rankTitle,
      };
    }
    const defaultUser = {
      address,
      balance: 1000,
      pendingWinnings: 0,
      totalWins: 3,
      totalLosses: 1,
      currentStreak: 3,
      xp: 410,
      rankTitle: 'Rookie',
    };
    await mockPrisma.mockLeaderboard.create({
      data: {
        address: defaultUser.address,
        rank: 0,
        balance: defaultUser.balance,
        pendingWinnings: defaultUser.pendingWinnings,
        totalWins: defaultUser.totalWins,
        totalLosses: defaultUser.totalLosses,
        winStreak: defaultUser.currentStreak,
        xp: defaultUser.xp,
        rankTitle: defaultUser.rankTitle,
      },
    });
    return defaultUser;
  }

  private async placeMockBet(
    roundId: string,
    address: string,
    amount: number,
    side?: 'UP' | 'DOWN',
    predictedPrice?: number,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.mockLeaderboard.findUnique({ where: { address } });
      if (!existing) {
        await tx.mockLeaderboard.create({
          data: {
            address,
            rank: 0,
            balance: 1000,
            pendingWinnings: 0,
            totalWins: 3,
            totalLosses: 1,
            winStreak: 3,
            xp: 410,
            rankTitle: 'Rookie',
          },
        });
      }

      await tx.mockBet.create({
        data: {
          roundId,
          address,
          amount,
          side,
          predictedPrice,
        },
      });

      await tx.mockLeaderboard.update({
        where: { address },
        data: { balance: { decrement: amount } },
      });

      const round = await tx.mockRound.findUnique({ where: { id: roundId } });
      if (round) {
        if (round.mode === 'updown' && side) {
          await tx.mockRound.update({
            where: { id: roundId },
            data:
              side === 'UP'
                ? { poolUp: { increment: amount } }
                : { poolDown: { increment: amount } },
          });
        } else if (round.mode === 'precision') {
          await tx.mockRound.update({
            where: { id: roundId },
            data: {
              totalPool: { increment: amount },
              predictionCount: { increment: 1 },
            },
          });
        }
      }
    });
  }
}

export default new HackathonService();
