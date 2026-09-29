import { OutboxEventType } from '@prisma/client';
import type { PredictionSide, Prisma, PredictionChainStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { invalidateNamespace, invalidateLeaderboardSortedSet } from '../lib/redis';
import { UserPriceRange } from '../types/round.types';
import { toDecimal, toNumber, serializeMoney, serializeNullableMoney } from '../utils/decimal.util';
import {
   ValidationError,
   NotFoundError,
   BusinessRuleError,
   ErrorCode,
} from '../utils/errors';
import logger from '../utils/logger';
import { retryOrThrow } from '../utils/retry.util';
import { predictionsPlacedTotal } from '../metrics/application.metrics';
import {
   findRangeByBounds,
   parseRoundPriceRanges,
   updateRangePool,
   validateUserPriceRange,
} from '../utils/price-range.util';
import sorobanService from './soroban.service';

/** A single `Prediction` row as created/submitted by this service (all scalar fields). */
export type PredictionRow = Prisma.PredictionGetPayload<{}>;

/** A `Prediction` row with its fully-loaded related `Round`. */
export type UserPredictionRow = Prisma.PredictionGetPayload<{
   include: {
      round: true;
   };
}>;

/** A `Prediction` row with its related `User` (id + walletAddress only). */
export type RoundPredictionRow = Prisma.PredictionGetPayload<{
   include: {
      user: {
         select: {
            id: true;
            walletAddress: true;
         };
      };
   };
}>;

/** A single serialized prediction entry within a batch result. */
export interface BatchPredictionEntry {
   id: string;
   roundId: string;
   /** Serialized decimal string (8-dp), never a raw JSON number. */
   amount: string;
   side: PredictionSide | null;
   priceRange: Prisma.JsonValue | null;
   createdAt: Date;
}

/** One processed item inside {@link BatchPredictionsResult.results}. */
export interface BatchPredictionResultItem {
   index: number;
   success: boolean;
   prediction?: BatchPredictionEntry;
   error?: string;
}

/** Aggregated outcome of {@link PredictionService.submitBatchPredictions}. */
export interface BatchPredictionsResult {
   success: boolean;
   results: BatchPredictionResultItem[];
}

export class PredictionService {
   /**
    * Submits a prediction for a round
    */
   async submitPrediction(
      userId: string,
      roundId: string,
      amount: number,
      side?: 'UP' | 'DOWN',
      priceRange?: UserPriceRange,
   ): Promise<PredictionRow> {
      // Reservation transaction is short and unlikely to need retries.
      // Soroban must NEVER be retried by this wrapper.
      return this.submitPredictionInternal(
         userId,
         roundId,
         amount,
         side,
         priceRange
      );
   }

   /**
    * Internal implementation of prediction submission
    * 3-Phase pattern: Reservation -> Chain call -> Finalization
    */
   private async submitPredictionInternal(
      userId: string,
      roundId: string,
      amount: number,
      side?: 'UP' | 'DOWN',
      priceRange?: UserPriceRange,
   ): Promise<PredictionRow> {
      try {
         // --- Phase 1: DB Reservation ---
         const { prediction, user, updatedRound } = await prisma.$transaction(async tx => {
            const round = await tx.round.findUnique({
               where: { id: roundId },
            });

            if (!round) {
               throw new NotFoundError('Round not found', ErrorCode.NOT_FOUND);
            }

            if (round.status !== 'ACTIVE') {
               throw new BusinessRuleError(
                  'Round is not active',
                  ErrorCode.ROUND_NOT_ACTIVE
               );
            }

            const existingPrediction = await tx.prediction.findUnique({
               where: {
                  roundId_userId: {
                     roundId,
                     userId,
                  },
               },
            });

            if (existingPrediction) {
               if (
                  existingPrediction.chainStatus === 'PENDING' ||
                  existingPrediction.chainStatus === 'SUBMITTED'
               ) {
                  throw new BusinessRuleError(
                     'Prediction is currently being processed or reconciled on chain. Please wait.',
                     ErrorCode.BUSINESS_RULE_VIOLATION
                  );
               }

               if (existingPrediction.chainStatus === 'NEEDS_MANUAL_REVIEW') {
                  throw new BusinessRuleError(
                     'Previous prediction attempt requires manual review. Please contact support.',
                     ErrorCode.BUSINESS_RULE_VIOLATION
                  );
               }

               if (
                  existingPrediction.chainStatus === 'CONFIRMED' ||
                  existingPrediction.chainStatus === 'NOT_REQUIRED'
               ) {
                  throw new BusinessRuleError(
                     'User has already placed a prediction for this round',
                     ErrorCode.DUPLICATE_PREDICTION
                  );
               }
               // FAILED rows with compensation will be reused below.
            }

            if (round.mode === 'UP_DOWN') {
               if (!side) {
                  throw new ValidationError('Side (UP/DOWN) is required for UP_DOWN mode');
               }
            } else if (round.mode === 'LEGENDS') {
               if (!priceRange) {
                  throw new ValidationError('Price range is required for LEGENDS mode');
               }
               const priceRangeValidation = validateUserPriceRange(priceRange);
               if (!priceRangeValidation.valid) {
                  throw new ValidationError(`Price range must include numeric min and max with min < max`);
               }
               const ranges = parseRoundPriceRanges(round.priceRanges);
               const validRange = findRangeByBounds(ranges, priceRange.min, priceRange.max);
               if (!validRange) {
                  throw new ValidationError('Invalid price range for this round');
               }
            } else {
               throw new BusinessRuleError('Invalid game mode', ErrorCode.BUSINESS_RULE_VIOLATION);
            }

            const decimalAmount = toDecimal(amount);
            const amountNum = toNumber(decimalAmount);

            const existingUser = await tx.user.findUnique({
               where: { id: userId },
            });
            if (!existingUser) {
               throw new NotFoundError('User not found', ErrorCode.NOT_FOUND);
            }

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
               .catch((err: unknown) => {
                  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') {
                     throw new BusinessRuleError('Insufficient balance', ErrorCode.INSUFFICIENT_FUNDS);
                  }
                  throw err;
               });

            // Create or reuse prediction record
            const targetChainStatus = round.mode === 'LEGENDS' ? 'NOT_REQUIRED' : 'PENDING';
            let prediction: PredictionRow;

            if (existingPrediction && existingPrediction.chainStatus === 'FAILED') {
               prediction = await tx.prediction.update({
                  where: { id: existingPrediction.id },
                  data: {
                     amount: amountNum,
                     side,
                     priceRange: priceRange ? { min: priceRange.min, max: priceRange.max } : undefined,
                     chainStatus: targetChainStatus,
                     txHash: null,
                     chainAttemptCount: 0,
                     chainFailureReason: null,
                     chainSubmittedAt: null,
                     chainConfirmedAt: null,
                     chainFailedAt: null,
                     compensatedAt: null,
                     won: null,
                     payout: null,
                  },
               });
            } else {
               prediction = await tx.prediction.create({
                  data: {
                     roundId,
                     userId,
                     amount: amountNum,
                     side,
                     priceRange: priceRange ? { min: priceRange.min, max: priceRange.max } : undefined,
                     chainStatus: targetChainStatus,
                  },
               });
            }

            let updatedRoundResult: Prisma.RoundGetPayload<{}>;

            if (round.mode === 'UP_DOWN') {
               updatedRoundResult = await tx.round.update({
                  where: { id: roundId },
                  data: {
                     poolUp: side === 'UP' ? { increment: amountNum } : undefined,
                     poolDown: side === 'DOWN' ? { increment: amountNum } : undefined,
                  },
               });
               // No Soroban call or outbox events yet. Will be done in phase 2 and 3.
            } else if (round.mode === 'LEGENDS') {
               const ranges = parseRoundPriceRanges(round.priceRanges);
               const updatedRanges = updateRangePool(ranges, priceRange!.min, priceRange!.max, amount);

               updatedRoundResult = await tx.round.update({
                  where: { id: roundId },
                  data: {
                     priceRanges: updatedRanges as unknown as Prisma.InputJsonValue,
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: prediction.id,
                     aggregateType: 'prediction',
                     payload: {
                        eventName: 'prediction:placed',
                        room: 'round',
                        data: {
                           roundId,
                           predictionId: prediction.id,
                           amount: serializeMoney(prediction.amount),
                           side: prediction.side,
                           priceRange: prediction.priceRange,
                        },
                     },
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: roundId,
                     aggregateType: 'round',
                     payload: {
                        eventName: 'round_update',
                        room: `round:${roundId}`,
                        data: {
                           id: updatedRoundResult.id,
                           mode: updatedRoundResult.mode,
                           status: updatedRoundResult.status,
                           startTime: updatedRoundResult.startTime.toISOString(),
                           endTime: updatedRoundResult.endTime.toISOString(),
                           startPrice: serializeMoney(updatedRoundResult.startPrice),
                           endPrice: serializeNullableMoney(updatedRoundResult.endPrice),
                           poolUp: serializeMoney(updatedRoundResult.poolUp),
                           poolDown: serializeMoney(updatedRoundResult.poolDown),
                           priceRanges: updatedRoundResult.priceRanges,
                           resolvedAt: updatedRoundResult.resolvedAt ? updatedRoundResult.resolvedAt.toISOString() : null,
                        },
                     },
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: roundId,
                     aggregateType: 'round',
                     payload: {
                        eventName: 'round_update',
                        room: 'round',
                        data: {
                           id: updatedRoundResult.id,
                           mode: updatedRoundResult.mode,
                           status: updatedRoundResult.status,
                           startTime: updatedRoundResult.startTime.toISOString(),
                           endTime: updatedRoundResult.endTime.toISOString(),
                           startPrice: serializeMoney(updatedRoundResult.startPrice),
                           endPrice: serializeNullableMoney(updatedRoundResult.endPrice),
                           poolUp: serializeMoney(updatedRoundResult.poolUp),
                           poolDown: serializeMoney(updatedRoundResult.poolDown),
                           priceRanges: updatedRoundResult.priceRanges,
                           resolvedAt: updatedRoundResult.resolvedAt ? updatedRoundResult.resolvedAt.toISOString() : null,
                        },
                     },
                  },
               });

               logger.info(`Prediction submitted (LEGENDS): user=${userId}, round=${roundId}, range=${JSON.stringify(priceRange)}`);
            } else {
               // Fallback
               updatedRoundResult = round;
            }

            return { prediction, user, updatedRound: updatedRoundResult };
         });

         // --- Phase 2 & 3: Soroban and Finalization (UP_DOWN ONLY) ---
         if (updatedRound.mode === 'UP_DOWN') {
            try {
               const chainResult = await sorobanService.placeBet(user.walletAddress, amount, side!);
               await this.finalizeChainSuccess(prediction.id, roundId, prediction, updatedRound, chainResult?.txHash);
            } catch (chainError) {
               await this.handleChainFailure(prediction.id, chainError);
               throw chainError; // Propagate to caller
            }
         }

         void invalidateNamespace('leaderboard');
         void invalidateLeaderboardSortedSet();
         predictionsPlacedTotal.inc();

         if (updatedRound.mode === 'UP_DOWN') {
            const found = await prisma.prediction.findUnique({ where: { id: prediction.id } });
            return found ?? prediction;
         }

         return prediction;
      } catch (error) {
         logger.error('Failed to submit prediction:', error);
         throw error;
      }
   }

   private async finalizeChainSuccess(
      predictionId: string,
      roundId: string,
      prediction: PredictionRow,
      updatedRound: Prisma.RoundGetPayload<{}>,
      txHash?: string
   ): Promise<void> {
      await retryOrThrow(
         async () => {
            await prisma.$transaction(async tx => {
               const currentPred = await tx.prediction.findUnique({ where: { id: predictionId } });
               if (!currentPred || currentPred.chainStatus !== 'PENDING') return;

               await tx.prediction.update({
                  where: { id: predictionId },
                  data: {
                     chainStatus: 'CONFIRMED',
                     txHash,
                     chainConfirmedAt: new Date(),
                     chainAttemptCount: 1,
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: prediction.id,
                     aggregateType: 'prediction',
                     payload: {
                        eventName: 'prediction:placed',
                        room: 'round',
                        data: {
                           roundId,
                           predictionId: prediction.id,
                           amount: serializeMoney(prediction.amount),
                           side: prediction.side,
                           priceRange: prediction.priceRange,
                        },
                     },
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: roundId,
                     aggregateType: 'round',
                     payload: {
                        eventName: 'round_update',
                        room: `round:${roundId}`,
                        data: {
                           id: updatedRound.id,
                           mode: updatedRound.mode,
                           status: updatedRound.status,
                           startTime: updatedRound.startTime.toISOString(),
                           endTime: updatedRound.endTime.toISOString(),
                           startPrice: serializeMoney(updatedRound.startPrice),
                           endPrice: serializeNullableMoney(updatedRound.endPrice),
                           poolUp: serializeMoney(updatedRound.poolUp),
                           poolDown: serializeMoney(updatedRound.poolDown),
                           priceRanges: updatedRound.priceRanges,
                           resolvedAt: updatedRound.resolvedAt ? updatedRound.resolvedAt.toISOString() : null,
                        },
                     },
                  },
               });

               await tx.outboxEvent.create({
                  data: {
                     eventType: OutboxEventType.WEBSOCKET_EMIT,
                     aggregateId: roundId,
                     aggregateType: 'round',
                     payload: {
                        eventName: 'round_update',
                        room: 'round',
                        data: {
                           id: updatedRound.id,
                           mode: updatedRound.mode,
                           status: updatedRound.status,
                           startTime: updatedRound.startTime.toISOString(),
                           endTime: updatedRound.endTime.toISOString(),
                           startPrice: serializeMoney(updatedRound.startPrice),
                           endPrice: serializeNullableMoney(updatedRound.endPrice),
                           poolUp: serializeMoney(updatedRound.poolUp),
                           poolDown: serializeMoney(updatedRound.poolDown),
                           priceRanges: updatedRound.priceRanges,
                           resolvedAt: updatedRound.resolvedAt ? updatedRound.resolvedAt.toISOString() : null,
                        },
                     },
                  },
               });

               logger.info(`Prediction submitted and finalized (UP_DOWN): round=${roundId}, side=${prediction.side}`);
            });
         },
         'finalizeChainSuccess',
         {
            maxAttempts: 3,
            initialDelayMs: 50,
            maxDelayMs: 2000,
            backoffMultiplier: 2,
         }
      );
   }

   private async handleChainFailure(predictionId: string, error: unknown): Promise<void> {
      const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');

      if (isTimeout) {
         // Ambiguous timeout: leave for reconciliation
         await prisma.prediction.update({
            where: { id: predictionId },
            data: {
               chainStatus: 'SUBMITTED', // Or PENDING, keeping it distinct helps debugging
            },
         });
         logger.warn(`Chain call timed out for prediction ${predictionId}, left for reconciliation`);
      } else {
         // Definitive failure: compensate
         await this.compensatePrediction(predictionId);
         logger.error(`Chain call failed definitively for prediction ${predictionId}, compensated`);
      }
   }

   /**
    * Compensates a failed or stuck prediction by restoring user balance
    * and decrementing the round pool. Safe to call multiple times (idempotent,
    * guarded by compensatedAt).
    */
   async compensatePrediction(predictionId: string): Promise<void> {
      await prisma.$transaction(async tx => {
         const pred = await tx.prediction.findUnique({
            where: { id: predictionId },
            include: { round: true },
         });

         if (!pred || (pred.chainStatus !== 'PENDING' && pred.chainStatus !== 'FAILED' && pred.chainStatus !== 'SUBMITTED') || pred.compensatedAt) {
            return;
         }

         await tx.user.update({
            where: { id: pred.userId },
            data: {
               virtualBalance: { increment: pred.amount },
            },
         });

         if (pred.round.mode === 'UP_DOWN') {
            await tx.round.update({
               where: { id: pred.roundId },
               data: {
                  poolUp: pred.side === 'UP' ? { decrement: pred.amount } : undefined,
                  poolDown: pred.side === 'DOWN' ? { decrement: pred.amount } : undefined,
               },
            });
         }

         await tx.prediction.update({
            where: { id: predictionId },
            data: {
               compensatedAt: new Date(),
               chainStatus: 'FAILED',
               chainFailureReason: 'Chain transaction failed',
            },
         });
      });
   }

   /**
    * Confirms a prediction from the reconciliation worker after verifying
    * on-chain success (either via txHash or get_user_position).
    */
   async confirmPredictionFromReconciliation(
      predictionId: string,
      txHash?: string,
   ): Promise<void> {
      const pred = await prisma.prediction.findUnique({
         where: { id: predictionId },
         include: { round: true },
      });
      if (!pred || pred.chainStatus === 'CONFIRMED') return;

      await this.finalizeChainSuccess(
         predictionId,
         pred.roundId,
         pred,
         pred.round,
         txHash || pred.txHash || 'reconciled-no-txhash',
      );
   }

   /**
    * Flags a prediction as needing manual review when the reconciliation
    * worker cannot safely determine whether it succeeded or failed on chain.
    */
   async flagForManualReview(
      predictionId: string,
      reason: string,
   ): Promise<void> {
      await prisma.prediction.update({
         where: { id: predictionId },
         data: {
            chainStatus: 'NEEDS_MANUAL_REVIEW',
            chainFailureReason: reason,
         },
      });
   }

   /**
    * Submits multiple predictions in a batch with partial success handling
    */
   async submitBatchPredictions(
      userId: string,
      predictions: Array<{
         roundId: string;
         amount: number;
         side?: 'UP' | 'DOWN';
         priceRange?: UserPriceRange;
      }>
   ): Promise<BatchPredictionsResult> {
      const results: BatchPredictionResultItem[] = [];

      // Process each prediction individually to maintain transaction isolation
      for (let i = 0; i < predictions.length; i++) {
         const pred = predictions[i];
         try {
            const prediction = await this.submitPrediction(
               userId,
               pred.roundId,
               pred.amount,
               pred.side,
               pred.priceRange
            );

            results.push({
               index: i,
               success: true,
               prediction: {
                  id: prediction.id,
                  roundId: prediction.roundId,
                  amount: serializeMoney(prediction.amount),
                  side: prediction.side,
                  priceRange: prediction.priceRange,
                  createdAt: prediction.createdAt,
               },
            });
         } catch (error) {
            results.push({
               index: i,
               success: false,
               error: error instanceof Error ? error.message : 'Unknown error',
            });
         }
      }

      const successCount = results.filter(r => r.success).length;
      return {
         success: successCount > 0,
         results,
      };
   }

   /**
    * Gets user's predictions
    */
   async getUserPredictions(userId: string): Promise<UserPredictionRow[]> {
      try {
         const predictions = await prisma.prediction.findMany({
            where: { userId },
            include: {
               round: true,
            },
            orderBy: {
               createdAt: 'desc',
            },
         });

         return predictions;
      } catch (error) {
         logger.error('Failed to get user predictions:', error);
         throw error;
      }
   }

   /**
    * Gets predictions for a round
    */
   async getRoundPredictions(roundId: string): Promise<RoundPredictionRow[]> {
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
         logger.error('Failed to get round predictions:', error);
         throw error;
      }
   }
}

export default new PredictionService();
