import { BetStatus, BetMode, OutboxEventType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import sorobanService, { TransactionStatus } from './soroban.service';
import betService from './bet.service';
import outboxService, { BetConfirmedOutboxPayload, BetFailedOutboxPayload } from './outbox.service';

export interface ReconciliationResult {
  checked: number;
  confirmed: number;
  failed: number;
  errors: number;
  details: Array<{
    betId: string;
    txHash: string;
    previousStatus: BetStatus;
    newStatus: BetStatus;
    chainStatus: TransactionStatus;
  }>;
}

export interface ReconciliationConfig {
  /** Maximum age of SUBMITTED bets to reconcile (ms). Default: 5 minutes. */
  maxAgeMs: number;
  /** Maximum number of bets to process per run. Default: 50. */
  batchSize: number;
}

const DEFAULT_CONFIG: ReconciliationConfig = {
  maxAgeMs: 5 * 60 * 1000, // 5 minutes
  batchSize: 50,
};

export class ReconciliationService {
  /**
   * Reconciles stranded SUBMITTED bets by checking their on-chain transaction status.
   *
   * This method is safe to run repeatedly:
   * - Already CONFIRMED/RESOLVED/FAILED bets are skipped
   * - Idempotent: running twice on the same bet produces the same result
   * - Each bet transition + outbox event is atomic (single Prisma transaction)
   *
   * @param config - Optional configuration overrides
   * @returns Summary of reconciliation actions taken
   */
  async reconcileSubmittedBets(config: Partial<ReconciliationConfig> = {}): Promise<ReconciliationResult> {
    const { maxAgeMs, batchSize } = { ...DEFAULT_CONFIG, ...config };
    const cutoff = new Date(Date.now() - maxAgeMs);

    const result: ReconciliationResult = {
      checked: 0,
      confirmed: 0,
      failed: 0,
      errors: 0,
      details: [],
    };

    // Find SUBMITTED bets older than cutoff that have a txHash
    const strandedBets = await prisma.bet.findMany({
      where: {
        status: BetStatus.SUBMITTED,
        txHash: { not: null },
        submittedAt: { lt: cutoff },
      },
      orderBy: { submittedAt: 'asc' },
      take: batchSize,
    });

    if (strandedBets.length === 0) {
      logger.debug('Reconciliation: no stranded SUBMITTED bets found');
      return result;
    }

    logger.info(`Reconciliation: found ${strandedBets.length} stranded SUBMITTED bets to check`);

    for (const bet of strandedBets) {
      result.checked++;

      try {
        const chainStatus = await sorobanService.getTransactionStatus(bet.txHash!);

        const detail = {
          betId: bet.id,
          txHash: bet.txHash!,
          previousStatus: bet.status,
          newStatus: bet.status,
          chainStatus,
        };

        if (chainStatus.confirmed) {
          if (chainStatus.successful) {
            // Transaction confirmed and successful -> CONFIRMED
            await this.transitionToConfirmed(bet.id, bet.txHash!, bet.userId, bet.roundId, bet.mode);
            result.confirmed++;
            detail.newStatus = BetStatus.CONFIRMED;
            logger.info('Reconciliation: bet confirmed on-chain', { betId: bet.id, txHash: bet.txHash });
          } else {
            // Transaction confirmed but failed -> FAILED
            await this.transitionToFailed(bet.id, bet.userId, bet.roundId, bet.mode, chainStatus.error ?? 'Transaction failed on-chain');
            result.failed++;
            detail.newStatus = BetStatus.FAILED;
            logger.warn('Reconciliation: bet failed on-chain', { betId: bet.id, txHash: bet.txHash, error: chainStatus.error });
          }
        } else {
          // Transaction not yet confirmed (still pending or not found)
          // Leave as SUBMITTED, will be retried on next run
          logger.debug('Reconciliation: bet not yet confirmed on-chain', { betId: bet.id, txHash: bet.txHash });
        }

        result.details.push(detail);
      } catch (error) {
        result.errors++;
        logger.error('Reconciliation: error checking bet', {
          betId: bet.id,
          txHash: bet.txHash,
          error: error instanceof Error ? error.message : String(error),
        });
        result.details.push({
          betId: bet.id,
          txHash: bet.txHash!,
          previousStatus: bet.status,
          newStatus: bet.status,
          chainStatus: { confirmed: false, successful: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

    logger.info('Reconciliation completed', {
      checked: result.checked,
      confirmed: result.confirmed,
      failed: result.failed,
      errors: result.errors,
    });

    return result;
  }

  /**
   * Atomically transitions a bet to CONFIRMED and writes BET_CONFIRMED outbox event.
   */
  private async transitionToConfirmed(
    betId: string,
    txHash: string,
    userId: string,
    roundId: string | null,
    mode: BetMode
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Double-check status inside transaction (optimistic locking)
      const currentBet = await tx.bet.findUnique({ where: { id: betId } });
      if (!currentBet) return;
      if (currentBet.status !== BetStatus.SUBMITTED) return; // Already processed

      await tx.bet.update({
        where: { id: betId },
        data: {
          status: BetStatus.CONFIRMED,
          txHash,
          confirmedAt: new Date(),
        },
      });

      // Write BET_CONFIRMED outbox event atomically
      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_CONFIRMED,
          aggregateId: betId,
          aggregateType: 'bet',
          payload: {
            betId,
            userId,
            roundId,
            mode: mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
            txHash,
          } satisfies BetConfirmedOutboxPayload,
        },
      });
    });
  }

  /**
   * Atomically transitions a bet to FAILED and writes BET_FAILED outbox event.
   */
  private async transitionToFailed(
    betId: string,
    userId: string,
    roundId: string | null,
    mode: BetMode,
    reason: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const currentBet = await tx.bet.findUnique({ where: { id: betId } });
      if (!currentBet) return;
      if (currentBet.status !== BetStatus.SUBMITTED) return; // Already processed

      await tx.bet.update({
        where: { id: betId },
        data: {
          status: BetStatus.FAILED,
          failureReason: reason,
          failedAt: new Date(),
        },
      });

      // Write BET_FAILED outbox event atomically
      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_FAILED,
          aggregateId: betId,
          aggregateType: 'bet',
          payload: {
            betId,
            userId,
            roundId,
            mode: mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
            failureReason: reason,
          } satisfies BetFailedOutboxPayload,
        },
      });
    });
  }

  /**
   * Manual reconciliation for a specific bet by ID.
   * Useful for admin-triggered reconciliation.
   */
  async reconcileBetById(betId: string): Promise<ReconciliationResult> {
    const bet = await prisma.bet.findUnique({ where: { id: betId } });

    if (!bet) {
      logger.warn('Manual reconciliation: bet not found', { betId });
      return { checked: 0, confirmed: 0, failed: 0, errors: 1, details: [] };
    }

    if (bet.status !== BetStatus.SUBMITTED || !bet.txHash) {
      logger.warn('Manual reconciliation: bet not in SUBMITTED state or missing txHash', {
        betId,
        status: bet.status,
        hasTxHash: !!bet.txHash,
      });
      return { checked: 0, confirmed: 0, failed: 0, errors: 1, details: [] };
    }

    const result: ReconciliationResult = {
      checked: 0,
      confirmed: 0,
      failed: 0,
      errors: 0,
      details: [],
    };

    result.checked++;

    try {
      const chainStatus = await sorobanService.getTransactionStatus(bet.txHash);

      if (chainStatus.confirmed && chainStatus.successful) {
        await this.transitionToConfirmed(bet.id, bet.txHash, bet.userId, bet.roundId, bet.mode);
        result.confirmed++;
        result.details.push({
          betId: bet.id,
          txHash: bet.txHash,
          previousStatus: bet.status,
          newStatus: BetStatus.CONFIRMED,
          chainStatus,
        });
      } else if (chainStatus.confirmed && !chainStatus.successful) {
        await this.transitionToFailed(bet.id, bet.userId, bet.roundId, bet.mode, chainStatus.error ?? 'Transaction failed on-chain');
        result.failed++;
        result.details.push({
          betId: bet.id,
          txHash: bet.txHash,
          previousStatus: bet.status,
          newStatus: BetStatus.FAILED,
          chainStatus,
        });
      } else {
        result.details.push({
          betId: bet.id,
          txHash: bet.txHash,
          previousStatus: bet.status,
          newStatus: bet.status,
          chainStatus,
        });
      }
    } catch (error) {
      result.errors++;
      logger.error('Manual reconciliation error', {
        betId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }
}

export default new ReconciliationService();