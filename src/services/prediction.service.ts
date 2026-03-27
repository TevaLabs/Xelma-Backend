import { prisma } from "../lib/prisma";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import logger from "../utils/logger";
import { toDecimal, toNumber } from "../utils/decimal.util";
import { invalidateNamespace } from "../lib/redis";

interface PriceRange {
  min: number;
  max: number;
}

export class PredictionService {
  /**
   * Submits a prediction for a round
   */
  async submitPrediction(
    userId: string,
    roundId: string,
    amount: number,
    side?: "UP" | "DOWN",
    priceRange?: PriceRange,
  ): Promise<any> {
    try {
      const prediction = await prisma.$transaction(async (tx) => {
        // 1. Get round inside transaction to ensure consistency
        const round = await tx.round.findUnique({
          where: { id: roundId },
        });

        if (!round) {
          throw new Error("Round not found");
        }

        if (round.status !== "ACTIVE") {
          throw new Error("Round is not active");
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
          throw new Error("User has already placed a prediction for this round");
        }

        // 3. Validate mode-specific params early, before any writes
        if (round.mode === "UP_DOWN") {
          if (!side) {
            throw new Error("Side (UP/DOWN) is required for UP_DOWN mode");
          }
        } else if (round.mode === "LEGENDS") {
          if (!priceRange) {
            throw new Error("Price range is required for LEGENDS mode");
          }
          const ranges = round.priceRanges as any[];
          const validRange = ranges.find(
            (r) => r.min === priceRange.min && r.max === priceRange.max,
          );
          if (!validRange) {
            throw new Error("Invalid price range");
          }
        } else {
          throw new Error("Invalid game mode");
        }

        const decimalAmount = toDecimal(amount);
        const amountNum = toNumber(decimalAmount);

        // 4. Check user exists
        const existingUser = await tx.user.findUnique({ where: { id: userId } });
        if (!existingUser) {
          throw new Error("User not found");
        }

        // 5. Update user balance ATOMICALLY with sufficiency check
        // This prevents race conditions where balance is checked then deducted
        const user = await tx.user.update({
          where: {
            id: userId,
            virtualBalance: { gte: amountNum },
          },
          data: {
            virtualBalance: { decrement: amountNum },
          },
        }).catch((err: any) => {
          if (err.code === "P2025") {
            throw new Error("Insufficient balance");
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
            priceRange: priceRange as any,
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
          const ranges = round.priceRanges as any[];
          // Update price range pool (Note: JSON updates are not as atomic as increments in Prisma,
          // but being inside the same transaction with the round read above provides baseline safety)
          const updatedRanges = ranges.map((r) => {
            if (r.min === priceRange!.min && r.max === priceRange!.max) {
              return { ...r, pool: r.pool + amount };
            }
            return r;
          });

          await tx.round.update({
            where: { id: roundId },
            data: {
              priceRanges: updatedRanges as any,
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
