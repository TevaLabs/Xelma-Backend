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
  async placeBet(input: PlaceBetInput): Promise<BetResult> {
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
}

export default new HackathonService();
