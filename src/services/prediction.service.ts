import { PrismaClient } from "@prisma/client";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import logger from "../utils/logger";

const prisma = new PrismaClient();

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
      // Get round
      const round = await prisma.round.findUnique({
        where: { id: roundId },
      });

      if (!round) {
        throw new Error("Round not found");
      }

      if (round.status !== "ACTIVE") {
        throw new Error("Round is not active");
      }

      // Check if user already has a prediction for this round
      const existingPrediction = await prisma.prediction.findUnique({
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

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new Error("User not found");
      }

      // Check balance
      if (user.virtualBalance < amount) {
        throw new Error("Insufficient balance");
      }

      // Mode-specific logic
      if (round.mode === 0) {
        if (!side) {
          throw new Error("Side (UP/DOWN) is required for UP_DOWN mode");
        }

        // Call Soroban contract
        await sorobanService.placeBet(user.walletAddress, amount, side);

        // Create prediction in database
        const prediction = await prisma.prediction.create({
          data: {
            roundId,
            userId,
            mode: 0,
            amount,
            choice: side,
          },
        });

        // Update user balance
        await prisma.user.update({
          where: { id: userId },
          data: {
            virtualBalance: user.virtualBalance - amount,
          },
        });

        // Update round pools
        await prisma.round.update({
          where: { id: roundId },
          data: {
            poolUp: side === "UP" ? { increment: amount } : undefined,
            poolDown: side === "DOWN" ? { increment: amount } : undefined,
          },
        });

        logger.info(
          `Prediction submitted (UP_DOWN): user=${userId}, round=${roundId}, side=${side}`,
        );

        return prediction;
      } else if (round.mode === 1) {
        if (!priceRange) {
          throw new Error("Price range is required for LEGENDS mode");
        }

        // Validate price range exists in round
        const ranges = round.priceRanges as any[];
        const validRange = ranges.find(
          (r) => r.min === priceRange.min && r.max === priceRange.max,
        );

        if (!validRange) {
          throw new Error("Invalid price range");
        }

        // Create prediction in database
        const prediction = await prisma.prediction.create({
          data: {
            roundId,
            userId,
            mode: 1,
            amount,
            guessPrice: priceRange.min,
          },
        });

        // Update user balance
        await prisma.user.update({
          where: { id: userId },
          data: {
            virtualBalance: user.virtualBalance - amount,
          },
        });

        // Update price range pool
        const updatedRanges = ranges.map((r) => {
          if (r.min === priceRange.min && r.max === priceRange.max) {
            return { ...r, pool: r.pool + amount };
          }
          return r;
        });

        await prisma.round.update({
          where: { id: roundId },
          data: {
            priceRanges: updatedRanges as any,
          },
        });

        logger.info(
          `Prediction submitted (LEGENDS): user=${userId}, round=${roundId}, range=${JSON.stringify(priceRange)}`,
        );

        return prediction;
      }

      throw new Error("Invalid game mode");
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
