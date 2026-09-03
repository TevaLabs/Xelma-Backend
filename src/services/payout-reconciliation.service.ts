import { BetStatus, ClaimStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import sorobanService from './soroban.service';
import betAuditService from './bet-audit.service';
import {
  payoutClaimsFlaggedTotal,
  payoutClaimsInFlight,
  payoutClaimsResolvedTotal,
  payoutClaimsSubmittedTotal,
} from '../metrics/application.metrics';

export interface PayoutReconciliationConfig {
  /**
   * Minimum age of PENDING/FAILED claims before they are attempted (ms).
   * Default: 1 minute — long enough to outlive a just-created row so a user
   * claim racing the worker cannot double-submit, short enough that the next
   * 5-minute cron tick picks the row up.
   */
  pendingAgeMs: number;
  /**
   * Minimum age of SUBMITTED claims before their tx is re-checked on-chain (ms).
   * Default: 1 minute (on-chain confirmation usually takes seconds).
   */
  submittedAgeMs: number;
  /** Maximum claims processed per run. Default: 50. */
  batchSize: number;
  /**
   * Failed attempts before a claim is flagged NEEDS_MANUAL_REVIEW.
   * Default: 5 (~25 minutes at the default 5-minute cron).
   */
  maxAutoAttempts: number;
}

const DEFAULT_CONFIG: PayoutReconciliationConfig = {
  pendingAgeMs: 60 * 1000,
  submittedAgeMs: 60 * 1000,
  batchSize: 50,
  maxAutoAttempts: 5,
};

export interface PayoutReconciliationDetail {
  claimId: string;
  walletAddress: string;
  previousStatus: ClaimStatus;
  newStatus: ClaimStatus;
  txHash?: string;
  error?: string;
}

export interface PayoutReconciliationResult {
  /** Claim rows examined. */
  checked: number;
  /** Claim txs submitted on-chain (PENDING/FAILED -> SUBMITTED). */
  submitted: number;
  /** Claims confirmed paid on-chain (SUBMITTED -> CONFIRMED). */
  confirmed: number;
  /** Claims closed because on-chain pending winnings were 0 (nothing owed). */
  noPending: number;
  /** Attempts that failed but remain retryable (-> FAILED). */
  failed: number;
  /** Claims moved to NEEDS_MANUAL_REVIEW. */
  flagged: number;
  /** Per-item errors that left state unchanged (transient RPC, etc.). */
  errors: number;
  /** PENDING claim rows created by the candidate sweep. */
  swept: number;
  /** Claims left untouched this run (still in-flight, too young, etc.). */
  noop: number;
}

export interface PayoutSweepResult {
  swept: number;
  skippedOpen: number;
  skippedAlreadySwept: number;
}

/** Shape of a Claim row as read by the worker (subset we depend on). */
type ClaimRow = {
  id: string;
  walletAddress: string;
  status: ClaimStatus;
  txHash: string | null;
  amount: Prisma.Decimal | null;
  attempts: number;
};

/**
 * Payout reconciliation worker (Issue #492).
 *
 * Finds users with pending claimable balances and stuck claim/payout states,
 * then either resolves them (safe automatic retry against the chain) or flags
 * them for manual review.
 *
 * State machine over the `Claim` ledger:
 *
 *   PENDING  --(pending winnings > 0)--> SUBMITTED --(tx confirmed)--> CONFIRMED
 *      |                                     |  \-(tx reverted)--> NEEDS_MANUAL_REVIEW
 *      \--(pending winnings == 0)--> CONFIRMED (0 owed)
 *      \--(attempt failed)--> FAILED --(safe re-claim on next run)
 *   SUBMITTED / FAILED --(attempts exhausted)--> NEEDS_MANUAL_REVIEW
 *
 * Safety properties:
 * - **No double payout:** a claim tx is only submitted after re-reading
 *   on-chain pending winnings; once claimed the contract reports 0, so a
 *   retried submission cannot pay twice. A `txHash` unique constraint keeps
 *   the ledger from recording the same transaction twice.
 * - **No duplicate in-flight work:** rows are only worked once older than a
 *   grace period, the sweep never creates a second open row for a wallet, and
 *   a wallet with an in-flight claim is never re-submitted.
 * - **Race-safe writes:** every transition is an optimistic `updateMany`
 *   guarded on the current status, so a stale worker run cannot clobber a
 *   transition made by the current leader.
 * - **Single leader:** the scheduler wraps {@link run} in a distributed lock.
 */
export class PayoutReconciliationService {
  /** Runs one full sweep + reconciliation pass (the cron entry point). */
  async run(
    config: Partial<PayoutReconciliationConfig> = {},
  ): Promise<PayoutReconciliationResult> {
    const sweep = await this.sweepUnclaimedWinnings(config);
    const reconcile = await this.reconcilePendingPayouts(config);
    const result: PayoutReconciliationResult = {
      ...reconcile,
      swept: sweep.swept,
    };
    await this.recordOpenClaimGauges();
    return result;
  }

  /**
   * Discovers candidate wallets that may hold unclaimed on-chain winnings.
   *
   * A wallet is a candidate when it has at least one RESOLVED bet (i.e. it
   * played rounds that have settled and may owe it a payout) and no open
   * claim row (PENDING/SUBMITTED/FAILED) is already being worked. If the
   * wallet already has a CONFIRMED claim newer than its most recent resolved
   * bet, it was already swept after the last resolution and is skipped.
   */
  async sweepUnclaimedWinnings(
    config: Partial<PayoutReconciliationConfig> = {},
  ): Promise<PayoutSweepResult> {
    const { batchSize } = { ...DEFAULT_CONFIG, ...config };
    const result: PayoutSweepResult = { swept: 0, skippedOpen: 0, skippedAlreadySwept: 0 };

    // Most recent resolved bet per user (users who may hold winnings).
    const groups = await prisma.bet.groupBy({
      by: ['userId'],
      where: { status: BetStatus.RESOLVED },
      _max: { resolvedAt: true },
      orderBy: { userId: 'asc' },
      take: batchSize * 2, // headroom: some candidates are skipped below
    });

    for (const group of groups) {
      if (!group.userId) continue;

      const user = await prisma.user.findUnique({
        where: { id: group.userId },
        select: { id: true, walletAddress: true },
      });
      if (!user?.walletAddress) continue;

      const openClaim = await prisma.claim.findFirst({
        where: {
          walletAddress: user.walletAddress,
          status: {
            in: [ClaimStatus.PENDING, ClaimStatus.SUBMITTED, ClaimStatus.FAILED],
          },
        },
      });
      if (openClaim) {
        result.skippedOpen++;
        continue;
      }

      const latestSettledAt = group._max.resolvedAt;
      const latestConfirmed = await prisma.claim.findFirst({
        where: {
          walletAddress: user.walletAddress,
          status: ClaimStatus.CONFIRMED,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (
        latestSettledAt &&
        latestConfirmed &&
        latestConfirmed.createdAt.getTime() >= latestSettledAt.getTime()
      ) {
        // Already swept since the last round resolution — nothing new to claim.
        result.skippedAlreadySwept++;
        continue;
      }

      if (result.swept >= batchSize) break;

      await prisma.claim.create({
        data: {
          userId: user.id,
          walletAddress: user.walletAddress,
          status: ClaimStatus.PENDING,
        },
      });
      result.swept++;
      logger.debug('Payout sweep: queued candidate claim', {
        walletAddress: user.walletAddress,
        userId: user.id,
      });
    }

    if (result.swept > 0 || result.skippedOpen > 0 || result.skippedAlreadySwept > 0) {
      logger.info('Payout sweep completed', result);
    }
    return result;
  }

  /**
   * Reconciles stuck claim rows:
   * - SUBMITTED rows are re-checked against the chain (confirmed/failed/in-flight).
   * - PENDING/FAILED rows re-read on-chain pending winnings and either claim
   *   (safe retry), close as nothing-owed, or get flagged when retries exhaust.
   */
  async reconcilePendingPayouts(
    config: Partial<PayoutReconciliationConfig> = {},
  ): Promise<PayoutReconciliationResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const now = Date.now();

    const result: PayoutReconciliationResult = {
      checked: 0,
      submitted: 0,
      confirmed: 0,
      noPending: 0,
      failed: 0,
      flagged: 0,
      errors: 0,
      swept: 0,
      noop: 0,
    };

    const rows = await prisma.claim.findMany({
      where: {
        OR: [
          {
            status: ClaimStatus.SUBMITTED,
            updatedAt: { lt: new Date(now - cfg.submittedAgeMs) },
          },
          {
            status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
            updatedAt: { lt: new Date(now - cfg.pendingAgeMs) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: cfg.batchSize,
    });

    if (rows.length === 0) {
      logger.debug('Payout reconciliation: no stuck claims found');
      return result;
    }

    logger.info(`Payout reconciliation: ${rows.length} claim(s) to check`);

    for (const row of rows as ClaimRow[]) {
      result.checked++;

      try {
        if (row.status === ClaimStatus.SUBMITTED) {
          await this.reconcileSubmitted(row, cfg, result);
        } else {
          // PENDING or FAILED: (re)attempt a safe claim.
          await this.attemptClaim(row, cfg, result);
        }
      } catch (error) {
        result.errors++;
        logger.error('Payout reconciliation: error processing claim', {
          claimId: row.id,
          walletAddress: row.walletAddress,
          status: row.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.recordOpenClaimGauges();

    logger.info('Payout reconciliation completed', {
      checked: result.checked,
      submitted: result.submitted,
      confirmed: result.confirmed,
      noPending: result.noPending,
      failed: result.failed,
      flagged: result.flagged,
      errors: result.errors,
      noop: result.noop,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Per-status reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Re-checks a SUBMITTED claim against the chain and transitions it.
   */
  private async reconcileSubmitted(
    row: ClaimRow,
    cfg: PayoutReconciliationConfig,
    result: PayoutReconciliationResult,
  ): Promise<void> {
    // No txHash to check (e.g. the submission response lost it). Ground truth
    // comes from pending winnings: 0 means it landed (or nothing was owed),
    // > 0 means it never landed and a safe retry can be scheduled.
    if (!row.txHash) {
      const pending = await this.readPendingWinnings(row.walletAddress, result);
      if (pending === null) return; // transient error — counted, state untouched
      if (pending === 0n) {
        await this.markConfirmed(row, result, 'confirmed');
        return;
      }
      await this.recordFailedAttempt(
        row,
        cfg,
        result,
        'Claim submission has no txHash and winnings are still pending',
      );
      return;
    }

    const chain = await sorobanService.getTransactionStatus(row.txHash);

    if (chain.confirmed && chain.successful) {
      await this.markConfirmed(row, result, 'confirmed');
      return;
    }

    if (chain.confirmed && !chain.successful) {
      // Definitive on-chain revert. Automatic retry is unsafe without an
      // operator understanding why the contract rejected the claim.
      await this.flagForReview(
        row,
        result,
        'chain_reverted',
        chain.error ?? 'Claim transaction reverted on-chain',
      );
      return;
    }

    // Not confirmed yet. A dropped transaction must be retried instead of
    // stuck forever; a genuinely in-flight one is left for the next run.
    if (chain.error && /not found/i.test(chain.error)) {
      await this.recordFailedAttempt(
        row,
        cfg,
        result,
        'Claim transaction not found on-chain; retrying claim',
      );
      return;
    }

    if (chain.error) {
      // Transient RPC failure — leave the state untouched so the next run
      // re-checks the same tx.
      result.errors++;
      logger.warn('Payout reconciliation: chain check failed for claim', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        txHash: row.txHash,
        error: chain.error,
      });
      return;
    }

    // RPC reports the tx is still pending — nothing to do this run.
    result.noop++;
  }

  /**
   * Attempts to claim pending winnings for a PENDING/FAILED row. Safe retry:
   * pending winnings are re-read first, so a claim that already landed on a
   * previous run (e.g. after a timeout) can never be paid twice.
   */
  private async attemptClaim(
    row: ClaimRow,
    cfg: PayoutReconciliationConfig,
    result: PayoutReconciliationResult,
  ): Promise<void> {
    const pending = await this.readPendingWinnings(row.walletAddress, result);
    if (pending === null) return; // transient error — counted, state untouched

    if (pending === 0n) {
      // Nothing owed on-chain (already claimed by the user, or never won).
      await this.markConfirmed(row, result, 'no_pending');
      return;
    }

    // Belt-and-braces: never submit while a different row for the same wallet
    // is already in flight (the sweep prevents this, but a user endpoint race
    // must not double-submit).
    const inFlight = await prisma.claim.findFirst({
      where: {
        walletAddress: row.walletAddress,
        status: ClaimStatus.SUBMITTED,
        id: { not: row.id },
      },
      select: { id: true },
    });
    if (inFlight) {
      result.noop++;
      logger.debug('Payout reconciliation: another claim in flight, skipping', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        inFlightClaimId: inFlight.id,
      });
      return;
    }

    try {
      const claimed = await sorobanService.claimWinnings(row.walletAddress);

      // SUBMITTED until the tx confirms; amount comes from the contract
      // response (stroops -> XLM), txHash from the send response when present.
      const updated = await prisma.claim.updateMany({
        where: { id: row.id, status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] } },
        data: {
          status: ClaimStatus.SUBMITTED,
          txHash: claimed.txHash ?? row.txHash,
          amount:
            claimed.amount !== undefined && claimed.amount !== null
              ? claimed.amount
              : undefined,
          lastError: null,
        },
      });

      if (updated.count === 0) {
        // Another worker/user already moved this row — nothing more to do.
        result.noop++;
        return;
      }

      result.submitted++;
      payoutClaimsSubmittedTotal.inc({ source: 'worker' });
      betAuditService.emitClaimAccepted({
        address: row.walletAddress,
        amount: claimed.amount,
        result: claimed.state,
        txHash: claimed.txHash,
      });
      logger.info('Payout reconciliation: claim submitted', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        txHash: claimed.txHash,
        amount: claimed.amount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailedAttempt(
        row,
        cfg,
        result,
        `Claim submission failed: ${message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Transition helpers (all guarded on the previous status → race-safe)
  // ---------------------------------------------------------------------------

  /**
   * Confirms a claim (terminal CONFIRMED) either because its tx succeeded
   * on-chain (`outcome: 'confirmed'`) or because nothing is owed on-chain
   * (`outcome: 'no_pending'`, amount forced to 0).
   */
  private async markConfirmed(
    row: ClaimRow,
    result: PayoutReconciliationResult,
    outcome: 'confirmed' | 'no_pending',
  ): Promise<void> {
    const updated = await prisma.claim.updateMany({
      where: {
        id: row.id,
        status: { in: [ClaimStatus.PENDING, ClaimStatus.SUBMITTED, ClaimStatus.FAILED] },
      },
      data: {
        status: ClaimStatus.CONFIRMED,
        amount: outcome === 'no_pending' ? 0 : row.amount === null ? undefined : row.amount,
        lastError: null,
        claimedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      result.noop++;
      return;
    }

    if (outcome === 'no_pending') {
      result.noPending++;
      payoutClaimsResolvedTotal.inc({ outcome: 'no_pending' });
      logger.info('Payout reconciliation: claim closed (no pending winnings)', {
        claimId: row.id,
        walletAddress: row.walletAddress,
      });
    } else {
      result.confirmed++;
      payoutClaimsResolvedTotal.inc({ outcome: 'confirmed' });
      logger.info('Payout reconciliation: claim confirmed on-chain', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        txHash: row.txHash ?? undefined,
      });
    }
  }

  /**
   * Records a failed attempt. Retryable (FAILED) until attempts reach
   * `maxAutoAttempts`, after which the claim is flagged NEEDS_MANUAL_REVIEW.
   */
  private async recordFailedAttempt(
    row: ClaimRow,
    cfg: PayoutReconciliationConfig,
    result: PayoutReconciliationResult,
    reason: string,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const willFlag = attempts >= cfg.maxAutoAttempts;
    const nextStatus = willFlag ? ClaimStatus.NEEDS_MANUAL_REVIEW : ClaimStatus.FAILED;

    const updated = await prisma.claim.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: nextStatus,
        attempts: { increment: 1 },
        lastError: reason.slice(0, 1000),
      },
    });

    if (updated.count === 0) {
      result.noop++;
      return;
    }

    if (willFlag) {
      result.flagged++;
      payoutClaimsFlaggedTotal.inc({ reason: 'max_attempts' });
      logger.warn('Payout reconciliation: claim flagged for manual review', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        attempts,
        reason,
      });
    } else {
      result.failed++;
      logger.warn('Payout reconciliation: claim attempt failed (retryable)', {
        claimId: row.id,
        walletAddress: row.walletAddress,
        attempts,
        reason,
      });
    }
  }

  /**
   * Flags a claim as NEEDS_MANUAL_REVIEW immediately (automatic retry unsafe,
   * e.g. a definitive on-chain revert).
   */
  private async flagForReview(
    row: ClaimRow,
    result: PayoutReconciliationResult,
    reason: string,
    message: string,
  ): Promise<void> {
    const updated = await prisma.claim.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: ClaimStatus.NEEDS_MANUAL_REVIEW,
        attempts: { increment: 1 },
        lastError: message.slice(0, 1000),
      },
    });

    if (updated.count === 0) {
      result.noop++;
      return;
    }

    result.flagged++;
    payoutClaimsFlaggedTotal.inc({ reason });
    logger.error('Payout reconciliation: claim flagged for manual review', {
      claimId: row.id,
      walletAddress: row.walletAddress,
      reason,
      attempts: row.attempts + 1,
      message,
    });
  }

  /**
   * Reads on-chain pending winnings (stroops -> XLM as bigint). Returns null
   * on transient failure (counted as an error so a persistently broken RPC
   * eventually surfaces instead of looping silently).
   */
  private async readPendingWinnings(
    walletAddress: string,
    result: PayoutReconciliationResult,
  ): Promise<bigint | null> {
    try {
      return await sorobanService.getPendingWinnings(walletAddress);
    } catch (error) {
      result.errors++;
      logger.warn('Payout reconciliation: failed to read pending winnings', {
        walletAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Current claim counts by status, for admin metrics/ops dashboards. */
  async getReconciliationSummary(): Promise<Record<ClaimStatus, number>> {
    const groups = await prisma.claim.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const summary: Record<ClaimStatus, number> = {
      [ClaimStatus.PENDING]: 0,
      [ClaimStatus.SUBMITTED]: 0,
      [ClaimStatus.CONFIRMED]: 0,
      [ClaimStatus.FAILED]: 0,
      [ClaimStatus.NEEDS_MANUAL_REVIEW]: 0,
    };
    for (const group of groups) {
      summary[group.status] = group._count.status;
    }
    return summary;
  }

  /** Keeps the in-flight gauge in sync with the claim ledger. */
  private async recordOpenClaimGauges(): Promise<void> {
    const summary = await this.getReconciliationSummary();
    for (const status of Object.keys(summary) as ClaimStatus[]) {
      payoutClaimsInFlight.set({ status }, summary[status]);
    }
  }
}

export default new PayoutReconciliationService();
