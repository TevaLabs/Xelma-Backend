import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import educationTipService from "./education-tip.service";
import { prisma } from "../lib/prisma";
import { invalidateNamespace } from "../lib/redis";
import {
  toDecimal,
  toNumber,
  decAdd,
  decDiv,
  decMul,
  decEq,
  decFixed,
  decGte,
  decLte,
} from "../utils/decimal.util";
import { Decimal } from "@prisma/client/runtime/library";
import { ValidationError, ErrorCode } from "../utils/errors";
import { RoundLifecycleOutcome, RoundPriceRange, UserPriceRange } from "../types/round.types";
import { parseRoundPriceRanges, validateUserPriceRange } from "../utils/price-range.util";

function isValidRange(range: any): range is RoundPriceRange {
  return (
    range &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min < range.max
  );
}

export class ResolutionService {
  /**
   * Resolves a round with the final price
   */
  async resolveRound(roundId: string, finalPrice: number | string | Decimal): Promise<any> {
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
        return { outcome: RoundLifecycleOutcome.NO_OP };
      }

      if (round.status === "RESOLVED") {
        return {
          outcome: RoundLifecycleOutcome.ALREADY_RESOLVED,
          round: await prisma.round.findUnique({
            where: { id: roundId },
            include: { predictions: true },
          }),
        };
      }

      if (round.status !== "LOCKED" && round.status !== "ACTIVE") {
        return { outcome: RoundLifecycleOutcome.NO_OP };
      }

      const finalPriceDec = toDecimal(finalPrice);

      // Mode-specific resolution
      if (round.mode === "UP_DOWN") {
        await this.resolveUpDownRound(round, finalPriceDec);
      } else if (round.mode === "LEGENDS") {
        await this.resolveLegendsRound(round, finalPriceDec);
      }

      // Update round status and persist resolvedAt
      const resolvedAt = new Date();
      await prisma.round.update({
        where: { id: roundId },
        data: {
          status: "RESOLVED",
          endPrice: toNumber(finalPriceDec),
          resolvedAt,
        },
      });

      // Invalidate leaderboard after user stats affecting rankings change.
      void invalidateNamespace("leaderboard");

      logger.info(`Round resolved: ${roundId}, finalPrice=${finalPriceDec.toFixed(8)}`);
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

      return {
        outcome: RoundLifecycleOutcome.UPDATED,
        round: await prisma.round.findUnique({
          where: { id: roundId },
          include: {
            predictions: true,
          },
        }),
      };
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
    finalPrice: Decimal,
  ): Promise<void> {
    // Call Soroban contract to resolve
    await sorobanService.resolveRound(
      finalPrice,
      0,
      BigInt(Math.floor(Date.now() / 1000)),
    );

    const startPriceDec = toDecimal(round.startPrice);
    const priceWentUp = finalPrice.gt(startPriceDec);
    const priceWentDown = finalPrice.lt(startPriceDec);
    const priceUnchanged = finalPrice.eq(startPriceDec);

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
    finalPrice: Decimal,
  ): Promise<void> {
    const priceRanges = parseRoundPriceRanges(round.priceRanges);

    if (priceRanges.length === 0) {
      throw new ValidationError("LEGENDS round has no configured price ranges");
    }

    const invalidRange = priceRanges.find((range) => !isValidRange(range));
    if (invalidRange) {
      throw new ValidationError("LEGENDS round has invalid price range data");
    }

    const sortedRanges = [...priceRanges].sort((a, b) => a.min - b.min);

    // Find winning range with inclusive lower bound and exclusive upper bound,
    // except for the final range whose upper bound is inclusive.
    const winningRange = sortedRanges.find((range, index) => {
      const isLast = index === sortedRanges.length - 1;
      const min = toDecimal(range.min);
      const max = toDecimal(range.max);
      return isLast
        ? finalPrice.gte(min) && finalPrice.lte(max)
        : finalPrice.gte(min) && finalPrice.lt(max);
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
    const totalPool = sortedRanges.reduce(
      (sum, range) => decAdd(sum, range.pool),
      toDecimal(0),
    );
    const decWinningPool = toDecimal(winningRange.pool);
    const decLosingPool = toDecimal(totalPool).sub(decWinningPool);

    if (decEq(decWinningPool, 0)) {
      for (const prediction of round.predictions) {
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

      logger.info(
        `Round ${round.id}: Winning range had no predictions, all predictions marked as losses`,
      );
      return;
    }

    for (const prediction of round.predictions) {
      const priceRangeValidation = validateUserPriceRange(prediction.priceRange);
      if (!priceRangeValidation.valid) {
        logger.warn(`Invalid price range in prediction ${prediction.id}: ${priceRangeValidation.error}`);
        continue;
      }
      const predictionRange: UserPriceRange = priceRangeValidation.data;

      if (
        toDecimal(predictionRange.min).eq(toDecimal(winningRange.min)) &&
        toDecimal(predictionRange.max).eq(toDecimal(winningRange.max))
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
