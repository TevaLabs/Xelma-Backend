import { prisma } from "../lib/prisma";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import logger from "../utils/logger";
import { toDecimal, toNumber } from "../utils/decimal.util";

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
      return await prisma.$transaction(async (tx) => {
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

        const decimalAmount = toDecimal(amount);
        const amountNum = toNumber(decimalAmount);

        // 3. Check user exists and has sufficient balance, then deduct atomically
        const existingUser = await tx.user.findUnique({ where: { id: userId } });
        if (!existingUser) {
          throw new Error("User not found");
        }
        if (toNumber(toDecimal(existingUser.virtualBalance)) < amountNum) {
          throw new Error("Insufficient balance");
        }

        // 4. Check mode-specific requirements before deducting balance
        if (round.mode === "UP_DOWN" && !side) {
          throw new Error("Side (UP/DOWN) is required for UP_DOWN mode");
        }
        if (round.mode === "LEGENDS" && !priceRange) {
          throw new Error("Price range is required for LEGENDS mode");
        }
        if (
          round.mode === "LEGENDS" &&
          priceRange &&
          !(round as any).priceRanges?.some(
            (r: any) => r.min === priceRange.min && r.max === priceRange.max,
          )
        ) {
          throw new Error("Invalid price range");
        }

        const user = await tx.user.update({
          where: { id: userId },
          data: {
            virtualBalance: { decrement: amountNum },
          },
        });

        // 4. Create prediction record
        const prediction = await tx.prediction.create({
          data: {
            roundId,
            userId,
            amount: amountNum,
            side,
            priceRange: priceRange as any,
          },
        });

        // 5. Update round pools
        if (round.mode === "UP_DOWN") {
          await tx.round.update({
            where: { id: roundId },
            data: {
              poolUp: side === "UP" ? { increment: amountNum } : undefined,
              poolDown: side === "DOWN" ? { increment: amountNum } : undefined,
            },
          });

          // 6. External Soroban call: Ordering ensures DB is prepared but rolls back if chain call fails
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
        } else {
          throw new Error("Invalid game mode");
        }

        return prediction;
      });
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
