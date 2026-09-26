import { PredictionChainStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import sorobanService from './soroban.service';
import predictionService from './prediction.service';

export interface PredictionReconciliationResult {
  checked: number;
  confirmed: number;
  failed: number;
  unresolved: number;
  errors: number;
}

export interface PredictionReconciliationConfig {
  /** Maximum age of stuck predictions before attempting reconciliation. Default: 60s. */
  minAgeMs: number;
  /** Maximum number of predictions to inspect per sweep. Default: 50. */
  batchSize: number;
  /** Max retry attempts before marking NEEDS_MANUAL_REVIEW. Default: 5. */
  maxAttempts: number;
}

const DEFAULT_CONFIG: PredictionReconciliationConfig = {
  minAgeMs: 60 * 1000,
  batchSize: 50,
  maxAttempts: 5,
};

export class PredictionReconciliationService {
  async reconcilePredictions(
    config: Partial<PredictionReconciliationConfig> = {}
  ): Promise<PredictionReconciliationResult> {
    const { minAgeMs, batchSize, maxAttempts } = { ...DEFAULT_CONFIG, ...config };
    const cutoff = new Date(Date.now() - minAgeMs);

    const result: PredictionReconciliationResult = {
      checked: 0,
      confirmed: 0,
      failed: 0,
      unresolved: 0,
      errors: 0,
    };

    // Find PENDING or SUBMITTED predictions created before cutoff
    const stranded = await prisma.prediction.findMany({
      where: {
        chainStatus: { in: ['PENDING', 'SUBMITTED'] },
        createdAt: { lt: cutoff },
      },
      include: {
        round: true,
        user: true,
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    if (stranded.length === 0) {
      return result;
    }

    logger.info(`[prediction-reconciliation] Found ${stranded.length} stranded predictions to reconcile`);

    for (const pred of stranded) {
      result.checked++;
      try {
        if (pred.txHash) {
          const status = await sorobanService.getTransactionStatus(pred.txHash);
          if (status.confirmed && status.successful) {
            await predictionService.confirmPredictionFromReconciliation(pred.id, pred.txHash);
            result.confirmed++;
          } else if (status.confirmed && !status.successful) {
            await predictionService.compensatePrediction(pred.id);
            result.failed++;
          } else {
            // Still in flight or not found
            if (pred.chainAttemptCount >= maxAttempts) {
              await prisma.prediction.update({
                where: { id: pred.id },
                data: {
                  chainStatus: 'NEEDS_MANUAL_REVIEW',
                  chainFailureReason: `Exceeded max reconciliation attempts (${maxAttempts}) with tx error: ${status.error ?? 'unconfirmed'}`,
                },
              });
              result.unresolved++;
            } else {
              await prisma.prediction.update({
                where: { id: pred.id },
                data: { chainAttemptCount: { increment: 1 } },
              });
              result.unresolved++;
            }
          }
        } else {
          // No txHash saved (e.g. timeout during placeBet before txHash returned)
          let confirmedOnChain = false;
          if (pred.round?.sorobanRoundId && pred.user?.walletAddress) {
            try {
              const position = await sorobanService.getUserPosition(
                pred.round.sorobanRoundId,
                pred.user.walletAddress
              );
              if (position && position.amount > 0) {
                confirmedOnChain = true;
              }
            } catch (err) {
              logger.warn(`[prediction-reconciliation] Could not fetch user position for prediction ${pred.id}`, err);
            }
          }

          if (confirmedOnChain) {
            await predictionService.confirmPredictionFromReconciliation(pred.id);
            result.confirmed++;
          } else {
            if (pred.chainAttemptCount >= maxAttempts) {
              await predictionService.compensatePrediction(pred.id);
              result.failed++;
            } else {
              await prisma.prediction.update({
                where: { id: pred.id },
                data: { chainAttemptCount: { increment: 1 } },
              });
              result.unresolved++;
            }
          }
        }
      } catch (err) {
        result.errors++;
        logger.error(`[prediction-reconciliation] Failed to reconcile prediction ${pred.id}:`, err);
      }
    }

    return result;
  }
}

export default new PredictionReconciliationService();
