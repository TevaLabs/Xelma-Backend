import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import educationTipService from "./education-tip.service";
import { prisma } from "../lib/prisma";
import {
  toDecimal,
  toNumber,
  decAdd,
  decDiv,
  decMul,
  decEq,
  decFixed,
} from "../utils/decimal.util";
import { Decimal } from "@prisma/client/runtime/library";

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
      if (round.mode === "UP_DOWN") {
        await this.resolveUpDownRound(round, finalPrice);
      } else if (round.mode === "LEGENDS") {
        await this.resolveLegendsRound(round, finalPrice);
      }

      // Update round status and persist resolvedAt
      const resolvedAt = new Date();
      await prisma.round.update({
        where: { id: roundId },
        data: {
          status: "RESOLVED",
          endPrice: finalPrice,
          resolvedAt,
        },
      });

      logger.info(`Round resolved: ${roundId}, finalPrice=${finalPrice}`);
      // -----------------------------
      // Generate Educational Tip
      // -----------------------------
      try {
        const tip = await educationTipService.generateTip(roundId);

        logger.info("Educational tip generated for round", {
          roundId,
          category: tip.category,
          message: tip.message,
        });
      } catch (tipError) {
        logger.error("Failed to generate educational tip after resolution", {
          roundId,
          error:
            tipError instanceof Error ? tipError.message : "Unknown tip error",
        });
      }

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

    const priceWentUp = finalPrice > toNumber(round.startPrice);
    const priceWentDown = finalPrice < toNumber(round.startPrice);
    const priceUnchanged = finalPrice === toNumber(round.startPrice);

    const winningSide = priceWentUp ? "UP" : priceWentDown ? "DOWN" : null;

    if (priceUnchanged) {
      // Refund everyone
      for (const prediction of round.predictions) {
        const refundAmount = toDecimal(prediction.amount);
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: null,
            payout: toNumber(refundAmount),
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: toNumber(refundAmount),
            },
          },
        });
      }

      logger.info(
        `Round ${round.id}: Price unchanged, refunded all predictions`,
      );
      return;
    }

    // Calculate payouts for winners (decimal-safe)
    const winningPool = toDecimal(
      winningSide === "UP" ? round.poolUp : round.poolDown,
    );
    const losingPool = toDecimal(
      winningSide === "UP" ? round.poolDown : round.poolUp,
    );

    if (decEq(winningPool, 0)) {
      logger.warn(`Round ${round.id}: No winners, no payouts`);
      return;
    }

    for (const prediction of round.predictions) {
      if (prediction.side === winningSide) {
        // Winner: gets bet back + proportional share of losing pool (decimal-safe)
        const predAmount = toDecimal(prediction.amount);
        const share = decMul(decDiv(predAmount, winningPool), losingPool);
        const payout = decAdd(predAmount, share);

        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: true,
            payout: toNumber(payout),
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: toNumber(payout),
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
          message: `Your prediction was correct! You won ${decFixed(payout)} XLM in Round #${round.id.slice(0, 6)}.`,
          data: { roundId: round.id, amount: toNumber(payout) },
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
    const finalPriceDec = new Decimal(finalPrice);
    const priceRanges = round.priceRanges as PriceRange[];

    // Find winning range
    const winningRange = priceRanges.find((range) => {
      const min = new Decimal(range.min);
      const max = new Decimal(range.max);
      return finalPriceDec.gte(min) && finalPriceDec.lt(max);
    });

    if (!winningRange) {
      // Price outside all ranges - refund everyone
      for (const prediction of round.predictions) {
        const refundAmount = toDecimal(prediction.amount);
        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: null,
            payout: toNumber(refundAmount),
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: toNumber(refundAmount),
            },
          },
        });
      }

      logger.info(
        `Round ${round.id}: Price outside all ranges, refunded all predictions`,
      );
      return;
    }

    // Calculate total pool and winning pool (decimal-safe)
    const totalPool = priceRanges.reduce(
      (sum, range) => decAdd(sum, range.pool),
      toDecimal(0),
    );
    const decWinningPool = toDecimal(winningRange.pool);
    const decLosingPool = toDecimal(totalPool).sub(decWinningPool);

    if (decEq(decWinningPool, 0)) {
      logger.warn(`Round ${round.id}: No winners in range, no payouts`);
      return;
    }

    for (const prediction of round.predictions) {
      const predictionRange = prediction.priceRange as any;

      if (
        new Decimal(predictionRange.min).eq(winningRange.min) &&
        new Decimal(predictionRange.max).eq(winningRange.max)
      ) {
        // Winner (decimal-safe)
        const predAmount = toDecimal(prediction.amount);
        const share = decMul(decDiv(predAmount, decWinningPool), decLosingPool);
        const payout = decAdd(predAmount, share);

        await prisma.prediction.update({
          where: { id: prediction.id },
          data: {
            won: true,
            payout: toNumber(payout),
          },
        });

        await prisma.user.update({
          where: { id: prediction.userId },
          data: {
            virtualBalance: {
              increment: toNumber(payout),
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
