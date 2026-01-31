import sorobanService, { BlockchainError, BlockchainErrorType } from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import educationTipService from "./education-tip.service";
import { prisma } from "../lib/prisma";

interface PriceRange {
  min: number;
  max: number;
  pool: number;
}

/**
 * Resolution service error for application-level failures
 */
export class ResolutionServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "ResolutionServiceError";
    Object.setPrototypeOf(this, ResolutionServiceError.prototype);
  }
}

export class ResolutionService {
  /**
   * ORIGINAL + ENHANCED: Resolves a round with the final price
   * Now includes blockchain integration with proper error handling
   */
  async resolveRound(roundId: string, finalPrice: number): Promise<any> {
    const operationStart = Date.now();
    let blockchainTxHash: string | null = null;

    try {
      // ENHANCED: Validate inputs
      if (finalPrice <= 0) {
        throw new ResolutionServiceError(
          "Final price must be positive",
          "INVALID_FINAL_PRICE",
          400
        );
      }

      // ORIGINAL: Get round
      const round = await prisma.round.findUnique({
        where: { id: roundId },
        include: {
          predictions: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!round) {
        throw new ResolutionServiceError("Round not found", "ROUND_NOT_FOUND", 404);
      }

      if (round.status === "RESOLVED") {
        throw new ResolutionServiceError(
          "Round already resolved",
          "ALREADY_RESOLVED",
          400
        );
      }

      if (round.status !== "LOCKED" && round.status !== "ACTIVE") {
        throw new ResolutionServiceError(
          "Round must be locked or active to resolve",
          "INVALID_ROUND_STATUS",
          400
        );
      }

      // ENHANCED: Check if LEGENDS mode (not yet supported by blockchain)
      if (round.mode === 1) {
        logger.warn("LEGENDS mode resolution - blockchain integration not available", {
          roundId,
        });
        // Continue with database-only resolution for LEGENDS
      }

      // Step 1: ENHANCED - Resolve on blockchain first (for UP_DOWN mode only)
      if (round.mode === 0 && sorobanService.isInitialized()) {
        try {
          logger.info("Resolving round on blockchain", {
            roundId,
            finalPrice,
            mode: "UP_DOWN",
          });

          blockchainTxHash = await sorobanService.resolveRound(
            finalPrice,
            round.mode
          );

          logger.info("Blockchain resolution successful", {
            roundId,
            txHash: blockchainTxHash,
          });
        } catch (blockchainError: any) {
          // CRITICAL: Blockchain resolution failed
          // We log the error but DON'T block database resolution
          // because users need their payouts regardless of blockchain state
          logger.error("Blockchain resolution failed, continuing with database resolution", {
            roundId,
            error: blockchainError.message,
            errorType: blockchainError.type,
          });

          // Note: We don't throw here - we continue with database resolution
          // The blockchain can be resolved later via a retry mechanism
        }
      } else if (round.mode === 0 && !sorobanService.isInitialized()) {
        logger.warn("Soroban service not initialized, database-only resolution", {
          roundId,
        });
      }

      // Step 2: ORIGINAL - Mode-specific database resolution
      if (round.mode === 0) {
        await this.resolveUpDownRound(round, finalPrice);
      } else if (round.mode === 1) {
        await this.resolveLegendsRound(round, finalPrice);
      }

      // Step 3: ORIGINAL - Update round status
      await prisma.round.update({
        where: { id: roundId },
        data: {
          status: "RESOLVED",
          endPrice: finalPrice,
        },
      });

      const duration = Date.now() - operationStart;

      logger.info("Round resolved successfully", {
        roundId,
        finalPrice,
        mode: round.mode === 0 ? "UP_DOWN" : "LEGENDS",
        txHash: blockchainTxHash,
        durationMs: duration,
      });

      // ORIGINAL: Generate Educational Tip
      try {
        const tip = await educationTipService.generateTip(roundId);

        await prisma.round.update({
          where: { id: roundId },
          data: {
            educationalTip: tip.message,
            educationalTipCategory: tip.category,
          },
        });

        logger.info("Educational tip attached to round", {
          roundId,
          category: tip.category,
        });
      } catch (tipError) {
        logger.error("Failed to generate educational tip after resolution", {
          roundId,
          error:
            tipError instanceof Error ? tipError.message : "Unknown tip error",
        });
        // Don't throw - educational tip is non-critical
      }

      // ORIGINAL: Return resolved round
      return await prisma.round.findUnique({
        where: { id: roundId },
        include: {
          predictions: true,
        },
      });
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to resolve round", {
        roundId,
        finalPrice,
        error: error.message,
        errorType: error.type || error.name,
        durationMs: duration,
      });

      // Re-throw known error types
      if (error instanceof ResolutionServiceError || error instanceof BlockchainError) {
        throw error;
      }

      // Wrap unknown errors
      throw new ResolutionServiceError(
        `Failed to resolve round: ${error.message}`,
        "RESOLUTION_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Resolves an Up/Down mode round
   * All original payout logic preserved
   */
  private async resolveUpDownRound(
    round: any,
    finalPrice: number,
  ): Promise<void> {
    const priceWentUp = finalPrice > round.startPrice;
    const priceWentDown = finalPrice < round.startPrice;
    const priceUnchanged = finalPrice === round.startPrice;

    const winningSide = priceWentUp ? "UP" : priceWentDown ? "DOWN" : null;

    // ORIGINAL: Price unchanged - refund everyone
    if (priceUnchanged) {
      for (const prediction of round.predictions) {
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: null,
            payout: prediction.amount,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: prediction.amount,
            },
          },
        });
      }

      logger.info(
        `Round ${round.id}: Price unchanged, refunded all predictions`,
      );
      return;
    }

    // ORIGINAL: Calculate payouts for winners
    const winningPool = winningSide === "UP" ? round.poolUp : round.poolDown;
    const losingPool = winningSide === "UP" ? round.poolDown : round.poolUp;

    if (winningPool === 0) {
      logger.warn(`Round ${round.id}: No winners, no payouts`);
      return;
    }

    // ORIGINAL: Distribute payouts
    for (const prediction of round.predictions) {
      if (prediction.side === winningSide) {
        // ORIGINAL: Winner - gets bet back + proportional share of losing pool
        const share = (prediction.amount / winningPool) * losingPool;
        const payout = prediction.amount + share;

        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: true,
            payout,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: payout,
            },
            wins: {
              increment: 1,
            },
            streak: {
              increment: 1,
            },
          },
        });

        // ORIGINAL: Send WIN notification
        try {
          const winNotif = await notificationService.createNotification({
            userId: prediction.userId,
            type: "WIN",
            title: "You Won!",
            message: `Your prediction was correct! You won ${payout.toFixed(2)} XLM in Round #${round.id.slice(0, 6)}.`,
            data: { roundId: round.id, amount: payout },
          });
          if (winNotif) {
            websocketService.emitNotification(prediction.userId, winNotif);
          }
        } catch (notifError: any) {
          logger.warn("Failed to send WIN notification", {
            userId: prediction.userId,
            error: notifError.message,
          });
        }
      } else {
        // ORIGINAL: Loser
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: false,
            payout: 0,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            streak: 0,
          },
        });

        // ORIGINAL: Send LOSS notification
        try {
          const lossNotif = await notificationService.createNotification({
            userId: prediction.userId,
            type: "LOSS",
            title: "Prediction Did Not Win",
            message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
            data: { roundId: round.id },
          });
          if (lossNotif) {
            websocketService.emitNotification(prediction.userId, lossNotif);
          }
        } catch (notifError: any) {
          logger.warn("Failed to send LOSS notification", {
            userId: prediction.userId,
            error: notifError.message,
          });
        }
      }
    }

    logger.info(
      `Round ${round.id}: Distributed payouts to ${round.predictions.filter((p: any) => p.side === winningSide).length} winners`,
    );
  }

  /**
   * ORIGINAL: Resolves a Legends mode round
   * All original payout logic preserved
   */
  private async resolveLegendsRound(
    round: any,
    finalPrice: number,
  ): Promise<void> {
    const priceRanges = round.priceRanges as PriceRange[];

    // ORIGINAL: Find winning range
    const winningRange = priceRanges.find(
      (range) => finalPrice >= range.min && finalPrice < range.max,
    );

    // ORIGINAL: Price outside all ranges - refund everyone
    if (!winningRange) {
      for (const prediction of round.predictions) {
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: null,
            payout: prediction.amount,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: prediction.amount,
            },
          },
        });
      }

      logger.info(
        `Round ${round.id}: Price outside all ranges, refunded all predictions`,
      );
      return;
    }

    // ORIGINAL: Calculate total pool and winning pool
    const totalPool = priceRanges.reduce((sum, range) => sum + range.pool, 0);
    const winningPool = winningRange.pool;
    const losingPool = totalPool - winningPool;

    if (winningPool === 0) {
      logger.warn(`Round ${round.id}: No winners in range, no payouts`);
      return;
    }

    // ORIGINAL: Distribute payouts
    for (const prediction of round.predictions) {
      const predictionRange = prediction.priceRange as PriceRange;

      if (
        predictionRange.min === winningRange.min &&
        predictionRange.max === winningRange.max
      ) {
        // ORIGINAL: Winner
        const share = (prediction.amount / winningPool) * losingPool;
        const payout = prediction.amount + share;

        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: true,
            payout,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: payout,
            },
            wins: {
              increment: 1,
            },
            streak: {
              increment: 1,
            },
          },
        });
      } else {
        // ORIGINAL: Loser
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: false,
            payout: 0,
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            streak: 0,
          },
        });
      }
    }

    logger.info(
      `Round ${round.id}: Distributed payouts to winners in range [${winningRange.min}, ${winningRange.max}]`,
    );
  }
}

export default new ResolutionService();