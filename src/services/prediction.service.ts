import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { invalidateNamespace } from "../lib/redis";
import { UserPriceRange } from "../types/round.types";
import { toDecimal, toNumber } from "../utils/decimal.util";
import { ValidationError, NotFoundError, BusinessRuleError, ErrorCode } from "../utils/errors";
import logger from "../utils/logger";
import {
  findRangeByBounds,
  parseRoundPriceRanges,
  updateRangePool,
  validateUserPriceRange,
} from "../utils/price-range.util";
import sorobanService from "./soroban.service";

export class PredictionService {
  /**
   * Submits a prediction for a round
   */
  async submitPrediction(
    userId: string,
    roundId: string,
    amount: number,
    side?: "UP" | "DOWN",
    priceRange?: UserPriceRange,
  ): Promise<any> {
    try {
      const prediction = await prisma.$transaction(async (tx) => {
        // 1. Get round inside transaction to ensure consistency
        const round = await tx.round.findUnique({
          where: { id: roundId },
        });

        if (!round) {
          throw new NotFoundError("Round not found", ErrorCode.NOT_FOUND);
        }

        if (round.status !== "ACTIVE") {
          throw new BusinessRuleError("Round is not active", ErrorCode.ROUND_NOT_ACTIVE);
        }

        // 2. Check for existing prediction (atomic via @@unique constraint in schema)
        const existingPrediction = await tx.prediction.findUnique({
          where: {
            roundId_userId: {
              roundId,
              userId,
            },
          },
        });

        if (existingPrediction) {
          throw new BusinessRuleError(
            "User has already placed a prediction for this round",
            ErrorCode.DUPLICATE_PREDICTION,
          );
        }

        // 3. Validate mode-specific params early, before any writes
        if (round.mode === "UP_DOWN") {
          if (!side) {
            throw new ValidationError("Side (UP/DOWN) is required for UP_DOWN mode");
          }
        } else if (round.mode === "LEGENDS") {
          if (!priceRange) {
            throw new ValidationError(
              "Price range is required for LEGENDS mode",
            );
          }
          const priceRangeValidation = validateUserPriceRange(priceRange);
          if (!priceRangeValidation.valid) {
            throw new ValidationError(
              `Price range must include numeric min and max with min < max`,
            );
          }
          const ranges = parseRoundPriceRanges(round.priceRanges);
          const validRange = findRangeByBounds(
            ranges,
            priceRange.min,
            priceRange.max,
          );
          if (!validRange) {
            throw new ValidationError("Invalid price range for this round");
          }
        } else {
          throw new BusinessRuleError("Invalid game mode", ErrorCode.BUSINESS_RULE_VIOLATION);
        }

        const decimalAmount = toDecimal(amount);
        const amountNum = toNumber(decimalAmount);

        // 4. Check user exists
        const existingUser = await tx.user.findUnique({
          where: { id: userId },
        });
        if (!existingUser) {
          throw new NotFoundError("User not found", ErrorCode.NOT_FOUND);
        }

        // 5. Update user balance ATOMICALLY with sufficiency check
        // This prevents race conditions where balance is checked then deducted
        const user = await tx.user
          .update({
            where: {
              id: userId,
              virtualBalance: { gte: amountNum },
            },
            data: {
              virtualBalance: { decrement: amountNum },
            },
          })
          .catch((err: any) => {
            if (err.code === "P2025") {
              throw new BusinessRuleError("Insufficient balance", ErrorCode.INSUFFICIENT_FUNDS);
            }
            throw err;
          });

        // 6. Create prediction record
        const prediction = await tx.prediction.create({
          data: {
            roundId,
            userId,
            amount: amountNum,
            side,
            priceRange: priceRange
              ? { min: priceRange.min, max: priceRange.max }
              : undefined,
          },
        });

        // 7. Update round pools
        if (round.mode === "UP_DOWN") {
          await tx.round.update({
            where: { id: roundId },
            data: {
              poolUp: side === "UP" ? { increment: amountNum } : undefined,
              poolDown: side === "DOWN" ? { increment: amountNum } : undefined,
            },
          });

          // 8. External Soroban call: Ordering ensures DB is prepared but rolls back if chain call fails
          // This is our rollback strategy: DB transaction will only commit if placeBet succeeds.
          await sorobanService.placeBet(user.walletAddress, amount, side!);

          logger.info(
            `Prediction submitted (UP_DOWN): user=${userId}, round=${roundId}, side=${side}`,
          );
        } else if (round.mode === "LEGENDS") {
          const ranges = parseRoundPriceRanges(round.priceRanges);
          const updatedRanges = updateRangePool(
            ranges,
            priceRange!.min,
            priceRange!.max,
            amount,
          );

          await tx.round.update({
            where: { id: roundId },
            data: {
              priceRanges: updatedRanges as unknown as Prisma.InputJsonValue,
            },
          });

          logger.info(
            `Prediction submitted (LEGENDS): user=${userId}, round=${roundId}, range=${JSON.stringify(priceRange)}`,
          );
        }

        return prediction;
      });

      // Invalidate leaderboard after prediction write affects user stats.
      void invalidateNamespace("leaderboard");

      return prediction;
    } catch (error) {
      logger.error("Failed to submit prediction:", error);
      throw error;
    }
  }

  /**
   * Submits multiple predictions in a batch with partial success handling
   */
  async submitBatchPredictions(
    userId: string,
    predictions: Array<{
      roundId: string;
      amount: number;
      side?: "UP" | "DOWN";
      priceRange?: UserPriceRange;
    }>,
  ): Promise<{
    success: boolean;
    results: Array<{
      index: number;
      success: boolean;
      prediction?: any;
      error?: string;
    }>;
  }> {
    const results: Array<{
      index: number;
      success: boolean;
      prediction?: any;
      error?: string;
    }> = [];

    // Process each prediction individually to maintain transaction isolation
    for (let i = 0; i < predictions.length; i++) {
      const pred = predictions[i];
      try {
        const prediction = await this.submitPrediction(
          userId,
          pred.roundId,
          pred.amount,
          pred.side,
          pred.priceRange,
        );

        results.push({
          index: i,
          success: true,
          prediction: {
            id: prediction.id,
            roundId: prediction.roundId,
            amount: prediction.amount,
            side: prediction.side,
            priceRange: prediction.priceRange,
            createdAt: prediction.createdAt,
          },
        });
      } catch (error) {
        results.push({
          index: i,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      success: successCount > 0,
      results,
    };
  }

  /**
   * Gets user's predictions
   */
  async getUserPredictions(userId: string): Promise<any[]> {
    try {
      const predictions = await prisma.prediction.findMany({
        where: { userId },
        include: {
          round: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return predictions;
    } catch (error) {
      logger.error("Failed to get user predictions:", error);
      throw error;
    }
  }

  /**
   * Gets predictions for a round
   */
  async getRoundPredictions(roundId: string): Promise<any[]> {
    try {
      const predictions = await prisma.prediction.findMany({
        where: { roundId },
        include: {
          user: {
            select: {
              id: true,
              walletAddress: true,
            },
          },
        },
      });

      return predictions;
    } catch (error) {
      logger.error("Failed to get round predictions:", error);
      throw error;
    }
  }
}

export default new PredictionService();
