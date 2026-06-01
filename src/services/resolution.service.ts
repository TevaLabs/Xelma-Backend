import sorobanService from './soroban.service';
import logger from '../utils/logger';
import educationTipService from './education-tip.service';
import { prisma } from '../lib/prisma';
import { invalidateNamespace } from '../lib/redis';
import { OutboxEventType } from '@prisma/client';
import {
   toDecimal,
   toNumber,
   decAdd,
   decDiv,
   decMul,
   decEq,
   decFixed,
} from '../utils/decimal.util';
import { Decimal } from '@prisma/client/runtime/library';
import { ValidationError } from '../utils/errors';
import {
   RoundLifecycleOutcome,
   RoundPriceRange,
   UserPriceRange,
} from '../types/round.types';
import {
   parseRoundPriceRanges,
   validateUserPriceRange,
} from '../utils/price-range.util';
import { roundsResolvedTotal } from '../metrics/application.metrics';

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
    * Uses transactional semantics to prevent race conditions and duplicate payouts
    */
   async resolveRound(
      roundId: string,
      finalPrice: number | string | Decimal
   ): Promise<any> {
      try {
         // Get round outside transaction for initial checks
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

         if (round.status === 'RESOLVED') {
            return {
               outcome: RoundLifecycleOutcome.ALREADY_RESOLVED,
               round: await prisma.round.findUnique({
                  where: { id: roundId },
                  include: { predictions: true },
               }),
            };
         }

         if (round.status !== 'LOCKED' && round.status !== 'ACTIVE') {
            return { outcome: RoundLifecycleOutcome.NO_OP };
         }

         const finalPriceDec = toDecimal(finalPrice);

         // Wrap entire resolution in transaction to ensure atomicity
         // This prevents race conditions where concurrent resolution calls cause duplicate payouts
         const result = await prisma.$transaction(async tx => {
            // Re-fetch round inside transaction to get fresh state
            const txRound = await tx.round.findUnique({
               where: { id: roundId },
               include: {
                  predictions: {
                     include: {
                        user: true,
                     },
                  },
               },
            });

            if (!txRound) {
               return { outcome: RoundLifecycleOutcome.NO_OP };
            }

            // Double-check status inside transaction (optimistic locking pattern)
            // Prevents duplicate resolution if another process resolved it first
            if (txRound.status === 'RESOLVED') {
               return {
                  outcome: RoundLifecycleOutcome.ALREADY_RESOLVED,
                  round: txRound,
               };
            }

            if (txRound.status !== 'LOCKED' && txRound.status !== 'ACTIVE') {
               return { outcome: RoundLifecycleOutcome.NO_OP };
            }

            // Mode-specific resolution (all DB updates happen within transaction)
            if (txRound.mode === 'UP_DOWN') {
               await this.resolveUpDownRound(txRound, finalPriceDec, tx);
            } else if (txRound.mode === 'LEGENDS') {
               await this.resolveLegendsRound(txRound, finalPriceDec, tx);
            }

            // Update round status and persist resolvedAt (atomic with all payout updates)
            const resolvedAt = new Date();
            const updatedRound = await tx.round.update({
               where: { id: roundId },
               data: {
                  status: 'RESOLVED',
                  endPrice: toNumber(finalPriceDec),
                  resolvedAt,
               },
               include: {
                  predictions: true,
               },
            });

            logger.info(
               `Round resolved: ${roundId}, finalPrice=${finalPriceDec.toFixed(8)}`
            );

            return {
               outcome: RoundLifecycleOutcome.UPDATED,
               round: updatedRound,
            };
         });

         // Invalidate leaderboard after transaction commits
         void invalidateNamespace('leaderboard');

         if (result?.outcome === RoundLifecycleOutcome.UPDATED && result.round) {
            roundsResolvedTotal.inc({ mode: result.round.mode });
         }

         // Generate educational tip outside transaction (non-critical)
         try {
            const tip = await educationTipService.generateTip(roundId);

            logger.info('Educational tip generated for round', {
               roundId,
               category: tip.category,
               message: tip.message,
            });
         } catch (tipError) {
            logger.error(
               'Failed to generate educational tip after resolution',
               {
                  roundId,
                  error:
                     tipError instanceof Error
                        ? tipError.message
                        : 'Unknown tip error',
               }
            );
         }

         return result;
      } catch (error) {
         logger.error('Failed to resolve round:', error);
         throw error;
      }
   }

   /**
    * Resolves an Up/Down mode round
    * @param round - Round data with predictions
    * @param finalPrice - Final price for resolution
    * @param tx - Prisma transaction client (optional, uses global prisma if not provided)
    */
   private async resolveUpDownRound(
      round: any,
      finalPrice: Decimal,
      tx?: any
   ): Promise<void> {
      const db = tx || prisma;

      // Call Soroban contract to resolve
      // Note: This is called BEFORE DB updates. If it fails, transaction rolls back.
      // If it succeeds but DB update fails, we have a compensating transaction via retry.
      await sorobanService.resolveRound(
         finalPrice,
         0,
         BigInt(Math.floor(Date.now() / 1000))
      );

      const startPriceDec = toDecimal(round.startPrice);
      const priceWentUp = finalPrice.gt(startPriceDec);
      const priceWentDown = finalPrice.lt(startPriceDec);
      const priceUnchanged = finalPrice.eq(startPriceDec);

      const winningSide = priceWentUp ? 'UP' : priceWentDown ? 'DOWN' : null;

      if (priceUnchanged) {
         // Refund everyone
         for (const prediction of round.predictions) {
            const refundAmount = toDecimal(prediction.amount);
            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: null,
                  payout: toNumber(refundAmount),
               },
            });

            await db.user.update({
               where: { id: prediction.userId },
               data: {
                  virtualBalance: {
                     increment: toNumber(refundAmount),
                  },
               },
            });
         }

         logger.info(
            `Round ${round.id}: Price unchanged, refunded all predictions`
         );
         return;
      }

      // Calculate payouts for winners (decimal-safe)
      const winningPool = toDecimal(
         winningSide === 'UP' ? round.poolUp : round.poolDown
      );
      const losingPool = toDecimal(
         winningSide === 'UP' ? round.poolDown : round.poolUp
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

            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: true,
                  payout: toNumber(payout),
               },
            });

            await db.user.update({
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

            // Write WIN notification outbox event atomically with the payout.
            // The outbox poller will dispatch the notification and websocket
            // emit after the transaction commits, guaranteeing at-least-once
            // delivery even if the process crashes mid-resolution.
            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.NOTIFICATION_CREATE,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     userId: prediction.userId,
                     type: 'WIN',
                     title: 'You Won!',
                     message: `Your prediction was correct! You won ${decFixed(payout)} XLM in Round #${round.id.slice(0, 6)}.`,
                     data: { roundId: round.id, amount: toNumber(payout) },
                  },
               },
            });

            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.WEBSOCKET_EMIT,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     eventName: 'notification:new',
                     room: `user:${prediction.userId}`,
                     userId: prediction.userId,
                     data: {
                        type: 'WIN',
                        title: 'You Won!',
                        message: `Your prediction was correct! You won ${decFixed(payout)} XLM in Round #${round.id.slice(0, 6)}.`,
                        data: { roundId: round.id, amount: toNumber(payout) },
                        isRead: false,
                     },
                  },
               },
            });
         } else {
            // Loser
            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: false,
                  payout: 0,
               },
            });

            await db.user.update({
               where: { id: prediction.userId },
               data: {
                  streak: 0,
               },
            });

            // Write LOSS notification outbox event atomically with the payout.
            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.NOTIFICATION_CREATE,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     userId: prediction.userId,
                     type: 'LOSS',
                     title: 'Prediction Did Not Win',
                     message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                     data: { roundId: round.id },
                  },
               },
            });

            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.WEBSOCKET_EMIT,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     eventName: 'notification:new',
                     room: `user:${prediction.userId}`,
                     userId: prediction.userId,
                     data: {
                        type: 'LOSS',
                        title: 'Prediction Did Not Win',
                        message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                        data: { roundId: round.id },
                        isRead: false,
                     },
                  },
               },
            });
         }
      }

      logger.info(
         `Round ${round.id}: Distributed payouts to ${round.predictions.filter((p: any) => p.side === winningSide).length} winners`
      );
   }

   /**
    * Resolves a Legends mode round
    * @param round - Round data with predictions
    * @param finalPrice - Final price for resolution
    * @param tx - Prisma transaction client (optional, uses global prisma if not provided)
    */
   private async resolveLegendsRound(
      round: any,
      finalPrice: Decimal,
      tx?: any
   ): Promise<void> {
      const db = tx || prisma;

      const priceRanges = parseRoundPriceRanges(round.priceRanges);

      if (priceRanges.length === 0) {
         throw new ValidationError(
            'LEGENDS round has no configured price ranges'
         );
      }

      const invalidRange = priceRanges.find(range => !isValidRange(range));
      if (invalidRange) {
         throw new ValidationError(
            'LEGENDS round has invalid price range data'
         );
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
            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: null,
                  payout: toNumber(refundAmount),
               },
            });

            await db.user.update({
               where: { id: prediction.userId },
               data: {
                  virtualBalance: {
                     increment: toNumber(refundAmount),
                  },
               },
            });
         }

         logger.info(
            `Round ${round.id}: Price outside all ranges, refunded all predictions`
         );
         return;
      }

      // Calculate total pool and winning pool (decimal-safe)
      const totalPool = sortedRanges.reduce(
         (sum, range) => decAdd(sum, range.pool),
         toDecimal(0)
      );
      const decWinningPool = toDecimal(winningRange.pool);
      const decLosingPool = toDecimal(totalPool).sub(decWinningPool);

      if (decEq(decWinningPool, 0)) {
         for (const prediction of round.predictions) {
            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: false,
                  payout: 0,
               },
            });

            await db.user.update({
               where: { id: prediction.userId },
               data: {
                  streak: 0,
               },
            });

            // Write LOSS outbox event — winning range existed but had no pool
            // (no one bet on it), so everyone is a loser.
            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.NOTIFICATION_CREATE,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     userId: prediction.userId,
                     type: 'LOSS',
                     title: 'Prediction Did Not Win',
                     message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                     data: { roundId: round.id },
                  },
               },
            });

            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.WEBSOCKET_EMIT,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     eventName: 'notification:new',
                     room: `user:${prediction.userId}`,
                     userId: prediction.userId,
                     data: {
                        type: 'LOSS',
                        title: 'Prediction Did Not Win',
                        message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                        data: { roundId: round.id },
                        isRead: false,
                     },
                  },
               },
            });
         }

         logger.info(
            `Round ${round.id}: Winning range had no predictions, all predictions marked as losses`
         );
         return;
      }

      for (const prediction of round.predictions) {
         const priceRangeValidation = validateUserPriceRange(
            prediction.priceRange
         );
         if (!priceRangeValidation.valid) {
            logger.warn(
               `Invalid price range in prediction ${prediction.id}: ${(priceRangeValidation as any).error}`
            );
            continue;
         }
         const predictionRange: UserPriceRange = priceRangeValidation.data;

         if (
            toDecimal(predictionRange.min).eq(toDecimal(winningRange.min)) &&
            toDecimal(predictionRange.max).eq(toDecimal(winningRange.max))
         ) {
            // Winner (decimal-safe)
            const predAmount = toDecimal(prediction.amount);
            const share = decMul(
               decDiv(predAmount, decWinningPool),
               decLosingPool
            );
            const payout = decAdd(predAmount, share);

            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: true,
                  payout: toNumber(payout),
               },
            });

            await db.user.update({
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

            // Write WIN outbox events atomically with the payout (LEGENDS mode).
            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.NOTIFICATION_CREATE,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     userId: prediction.userId,
                     type: 'WIN',
                     title: 'You Won!',
                     message: `Your prediction was correct! You won ${decFixed(payout)} XLM in Round #${round.id.slice(0, 6)}.`,
                     data: { roundId: round.id, amount: toNumber(payout) },
                  },
               },
            });

            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.WEBSOCKET_EMIT,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     eventName: 'notification:new',
                     room: `user:${prediction.userId}`,
                     userId: prediction.userId,
                     data: {
                        type: 'WIN',
                        title: 'You Won!',
                        message: `Your prediction was correct! You won ${decFixed(payout)} XLM in Round #${round.id.slice(0, 6)}.`,
                        data: { roundId: round.id, amount: toNumber(payout) },
                        isRead: false,
                     },
                  },
               },
            });
         } else {
            // Loser
            await db.prediction.update({
               where: { id: prediction.id },
               data: {
                  won: false,
                  payout: 0,
               },
            });

            await db.user.update({
               where: { id: prediction.userId },
               data: {
                  streak: 0,
               },
            });

            // Write LOSS outbox events atomically with the payout (LEGENDS mode).
            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.NOTIFICATION_CREATE,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     userId: prediction.userId,
                     type: 'LOSS',
                     title: 'Prediction Did Not Win',
                     message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                     data: { roundId: round.id },
                  },
               },
            });

            await db.outboxEvent.create({
               data: {
                  eventType: OutboxEventType.WEBSOCKET_EMIT,
                  aggregateId: round.id,
                  aggregateType: 'round',
                  payload: {
                     eventName: 'notification:new',
                     room: `user:${prediction.userId}`,
                     userId: prediction.userId,
                     data: {
                        type: 'LOSS',
                        title: 'Prediction Did Not Win',
                        message: `Your prediction in Round #${round.id.slice(0, 6)} did not win. Keep trying!`,
                        data: { roundId: round.id },
                        isRead: false,
                     },
                  },
               },
            });
         }
      }

      logger.info(
         `Round ${round.id}: Distributed payouts to winners in range [${winningRange.min}, ${winningRange.max}]`
      );
   }
}

export default new ResolutionService();
