import { PrismaClient } from "@prisma/client";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";

const prisma = new PrismaClient();

interface PriceRange {
  min: number;
  max: number;
  pool: number;
}

export class ResolutionService {
  /**
   * Resolves a round with the final price
   */
  async resolveRound(roundId: string, finalPrice: number): Promise<any> {
    try {
      // Get round
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
        throw new Error("Round not found");
      }

      if (round.status === "RESOLVED") {
        throw new Error("Round already resolved");
      }

      if (round.status !== "LOCKED" && round.status !== "ACTIVE") {
        throw new Error("Round must be locked or active to resolve");
      }

      // Mode-specific resolution
      if (round.mode === 0) {
        await this.resolveUpDownRound(round, finalPrice);
      } else if (round.mode === 1) {
        await this.resolveLegendsRound(round, finalPrice);
      }

      // Update round status
      await prisma.round.update({
        where: { id: roundId },
        data: {
          status: "RESOLVED",
          endPrice: finalPrice,
          resolvedAt: new Date(),
        },
      });

      logger.info(`Round resolved: ${roundId}, finalPrice=${finalPrice}`);

      return await prisma.round.findUnique({
        where: { id: roundId },
        include: {
          predictions: true,
        },
      });
    } catch (error) {
      logger.error("Failed to resolve round:", error);
      throw error;
    }
  }

  /**
   * Resolves an Up/Down mode round
   */
  private async resolveUpDownRound(
    round: any,
    finalPrice: number,
  ): Promise<void> {
    // Call Soroban contract to resolve
    await sorobanService.resolveRound(finalPrice);

    const priceWentUp = finalPrice > round.startPrice;
    const priceWentDown = finalPrice < round.startPrice;
    const priceUnchanged = finalPrice === round.startPrice;

    const winningSide = priceWentUp ? "UP" : priceWentDown ? "DOWN" : null;

    if (priceUnchanged) {
      // Refund everyone
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

    // Calculate payouts for winners
    const winningPool = winningSide === "UP" ? round.poolUp : round.poolDown;
    const losingPool = winningSide === "UP" ? round.poolDown : round.poolUp;

    if (winningPool === 0) {
      logger.warn(`Round ${round.id}: No winners, no payouts`);
      return;
    }

    for (const prediction of round.predictions) {
      if (prediction.side === winningSide) {
        // Winner: gets bet back + proportional share of losing pool
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

        // Send WIN notification
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
      } else {
        // Loser
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

        // Send LOSS notification
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
      }
    }

    logger.info(
      `Round ${round.id}: Distributed payouts to ${round.predictions.filter((p: any) => p.side === winningSide).length} winners`,
    );
  }

  /**
   * Resolves a Legends mode round
   */
  private async resolveLegendsRound(
    round: any,
    finalPrice: number,
  ): Promise<void> {
    const priceRanges = round.priceRanges as PriceRange[];

    // Find winning range
    const winningRange = priceRanges.find(
      (range) => finalPrice >= range.min && finalPrice < range.max,
    );

    if (!winningRange) {
      // Price outside all ranges - refund everyone
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

    // Calculate total pool and winning pool
    const totalPool = priceRanges.reduce((sum, range) => sum + range.pool, 0);
    const winningPool = winningRange.pool;
    const losingPool = totalPool - winningPool;

    if (winningPool === 0) {
      logger.warn(`Round ${round.id}: No winners in range, no payouts`);
      return;
    }

    for (const prediction of round.predictions) {
      const predictionRange = prediction.priceRange as PriceRange;

      if (
        predictionRange.min === winningRange.min &&
        predictionRange.max === winningRange.max
      ) {
        // Winner
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
        // Loser
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
