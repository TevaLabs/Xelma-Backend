import { PrismaClient } from "@prisma/client";
import sorobanService, { BlockchainError } from "./soroban.service";
import websocketService from "./websocket.service";
import logger from "../utils/logger";

const prisma = new PrismaClient();

interface PriceRange {
  min: number;
  max: number;
}

/**
 * Prediction service error
 */
export class PredictionServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "PredictionServiceError";
    Object.setPrototypeOf(this, PredictionServiceError.prototype);
  }
}

export class PredictionService {
  /**
   * ORIGINAL + ENHANCED: Submit a prediction for a round
   * Now includes blockchain integration with rollback on failure
   * 
   * NOTE: This method expects userSecretKey to be provided from the route layer
   * which extracts it from the x-signature header
   */
  async submitPrediction(
    userId: string,
    roundId: string,
    amount: number,
    side?: "UP" | "DOWN",
    priceRange?: PriceRange,
    userSecretKey?: string  // NEW: Optional for blockchain integration
  ): Promise<any> {
    const operationStart = Date.now();
    let createdPredictionId: string | null = null;

    try {
      // ORIGINAL: Get round
      const round = await prisma.round.findUnique({
        where: { id: roundId },
      });

      if (!round) {
        throw new PredictionServiceError("Round not found", "ROUND_NOT_FOUND", 404);
      }

      // ORIGINAL: Validate round status
      if (round.status !== "ACTIVE") {
        throw new PredictionServiceError(
          "Round is not active",
          "ROUND_NOT_ACTIVE",
          400
        );
      }

      // ENHANCED: Check if round has ended
      if (new Date() > round.endTime) {
        throw new PredictionServiceError(
          "Round has ended, no longer accepting bets",
          "ROUND_ENDED",
          400
        );
      }

      // ORIGINAL: Check if user already has a prediction for this round
      const existingPrediction = await prisma.prediction.findUnique({
        where: {
          roundId_userId: {
            roundId,
            userId,
          },
        },
      });

      if (existingPrediction) {
        throw new PredictionServiceError(
          "User has already placed a prediction for this round",
          "PREDICTION_EXISTS",
          409
        );
      }

      // ORIGINAL: Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new PredictionServiceError("User not found", "USER_NOT_FOUND", 404);
      }

      // ORIGINAL: Check balance
      if (user.virtualBalance < amount) {
        throw new PredictionServiceError(
          `Insufficient balance. Required: ${amount}, Available: ${user.virtualBalance}`,
          "INSUFFICIENT_BALANCE",
          400
        );
      }

      // ORIGINAL: Mode-specific logic
      if (round.mode === "UP_DOWN") {
        if (!side) {
          throw new PredictionServiceError(
            "Side (UP/DOWN) is required for UP_DOWN mode",
            "SIDE_REQUIRED",
            400
          );
        }

        // Step 1: ORIGINAL - Create prediction in database with PENDING status
        const prediction = await prisma.prediction.create({
          data: {
            roundId,
            userId,
            amount,
            side,
          },
        });

        createdPredictionId = prediction.id;

        logger.info("Database prediction created", {
          predictionId: prediction.id,
          roundId,
          userId,
          side,
          amount,
        });

        // Step 2: NEW - Submit to blockchain (if Soroban is enabled AND user provided secret key)
        let txHash: string | null = null;
        if (sorobanService.isInitialized() && userSecretKey) {
          try {
            if (!user.walletAddress) {
              throw new PredictionServiceError(
                "User wallet address not configured",
                "WALLET_NOT_CONFIGURED",
                400
              );
            }

            logger.info("Submitting bet to blockchain", {
              predictionId: prediction.id,
              roundId,
              userAddress: user.walletAddress.slice(0, 8) + "...",
              amount,
              side,
            });

            // Convert amount to stroops (BigInt)
            const amountInStroops = BigInt(amount) * 10_000_000n;
            const modeNum = 0; // UP_DOWN mode

            txHash = await sorobanService.placeBet(
              user.walletAddress,
              userSecretKey,
              amountInStroops,
              side,
              modeNum
            );

            logger.info("Blockchain bet placement successful", {
              predictionId: prediction.id,
              txHash,
            });

            // Update prediction with transaction hash
            await prisma.prediction.update({
              where: { id: prediction.id },
              data: {
                // Note: Add txHash field to Prediction model if needed
                // For now, we just log it
              },
            });
          } catch (blockchainError: any) {
            // NEW: Blockchain failed - rollback database
            logger.error("Blockchain bet placement failed, rolling back", {
              predictionId: prediction.id,
              error: blockchainError.message,
              errorType: blockchainError.type,
            });

            // Delete the prediction we just created
            await prisma.prediction.delete({
              where: { id: prediction.id },
            });

            // Re-throw the blockchain error so the route can handle it
            throw blockchainError;
          }
        } else if (!sorobanService.isInitialized()) {
          logger.warn("Soroban service not initialized, prediction created in database only", {
            predictionId: prediction.id,
          });
        } else if (!userSecretKey) {
          logger.warn("User secret key not provided, prediction created in database only", {
            predictionId: prediction.id,
          });
        }

        // Step 3: ORIGINAL - Update user balance and round pools
        await prisma.$transaction([
          // Deduct from user balance
          prisma.user.update({
            where: { id: userId },
            data: {
              virtualBalance: {
                decrement: amount,
              },
            },
          }),
          // Update round pool
          prisma.round.update({
            where: { id: roundId },
            data: {
              poolUp: side === "UP" ? { increment: amount } : undefined,
              poolDown: side === "DOWN" ? { increment: amount } : undefined,
            },
          }),
          // Create transaction record
          prisma.transaction.create({
            data: {
              userId,
              amount: -amount,
              type: "LOSS", // Initially recorded as loss, will update if wins
              description: `Bet on round ${roundId.slice(0, 8)}`,
              roundId,
            },
          }),
        ]);

        const duration = Date.now() - operationStart;

        logger.info("Prediction submitted (UP_DOWN)", {
          predictionId: prediction.id,
          userId,
          roundId,
          side,
          amount,
          txHash,
          durationMs: duration,
        });

        return prediction;
      } else if (round.mode === "LEGENDS") {
        // ORIGINAL: LEGENDS mode logic
        if (!priceRange) {
          throw new PredictionServiceError(
            "Price range is required for LEGENDS mode",
            "PRICE_RANGE_REQUIRED",
            400
          );
        }

        const ranges = round.priceRanges as any[];
        const validRange = ranges.find(
          (r) => r.min === priceRange.min && r.max === priceRange.max
        );

        if (!validRange) {
          throw new PredictionServiceError(
            "Invalid price range",
            "INVALID_PRICE_RANGE",
            400
          );
        }

        const prediction = await prisma.prediction.create({
          data: {
            roundId,
            userId,
            amount,
            priceRange,
          },
        });

        createdPredictionId = prediction.id;

        // Note: LEGENDS mode blockchain integration would go here
        // Currently not supported by smart contract

        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              virtualBalance: {
                decrement: amount,
              },
            },
          }),
          prisma.transaction.create({
            data: {
              userId,
              amount: -amount,
              type: "LOSS",
              description: `LEGENDS bet on round ${roundId.slice(0, 8)}`,
              roundId,
            },
          }),
        ]);

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

        logger.info("Prediction submitted (LEGENDS)", {
          predictionId: prediction.id,
          userId,
          roundId,
          priceRange: JSON.stringify(priceRange),
        });

        return prediction;
      }

      throw new PredictionServiceError(
        "Invalid game mode",
        "INVALID_GAME_MODE",
        400
      );
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to submit prediction", {
        userId,
        roundId,
        amount,
        error: error.message,
        errorType: error.type || error.name,
        durationMs: duration,
        predictionId: createdPredictionId,
      });

      // If we created a prediction but something failed after, try to delete it
      if (
        createdPredictionId &&
        !(error instanceof BlockchainError) && // Already rolled back if blockchain error
        error.code !== "PREDICTION_EXISTS"
      ) {
        try {
          await prisma.prediction.delete({
            where: { id: createdPredictionId },
          });
          logger.info("Rolled back prediction after error", {
            predictionId: createdPredictionId,
          });
        } catch (rollbackError: any) {
          logger.error("Failed to rollback prediction after error", {
            predictionId: createdPredictionId,
            rollbackError: rollbackError.message,
          });
        }
      }

      // Re-throw known error types
      if (error instanceof PredictionServiceError || error instanceof BlockchainError) {
        throw error;
      }

      // Wrap unknown errors
      throw new PredictionServiceError(
        `Failed to submit prediction: ${error.message}`,
        "PREDICTION_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Get user's predictions
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
    } catch (error: any) {
      logger.error("Failed to get user predictions:", error);
      throw new PredictionServiceError(
        `Failed to get user predictions: ${error.message}`,
        "GET_PREDICTIONS_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Get predictions for a round
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
    } catch (error: any) {
      logger.error("Failed to get round predictions:", error);
      throw new PredictionServiceError(
        `Failed to get round predictions: ${error.message}`,
        "GET_PREDICTIONS_FAILED",
        500
      );
    }
  }
}

export default new PredictionService();