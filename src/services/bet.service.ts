import { BetStatus, BetMode, PredictionSide, OutboxEventType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import sorobanService from './soroban.service';
import betAuditService from './bet-audit.service';
import outboxService, { BetAcceptedOutboxPayload, BetConfirmedOutboxPayload, BetResolvedOutboxPayload, BetFailedOutboxPayload } from './outbox.service';
import { serializeMoney } from '../utils/decimal.util';
import { toDecimal, toNumber } from '../utils/decimal.util';
import { NotFoundError, ValidationError } from '../utils/errors';

export interface UpDownBetInput {
  address: string;
  amount: number;
  side: 'UP' | 'DOWN';
  /**
   * Bind the bet to a specific round. Round-scoped callers such as
   * `POST /api/rounds/:id/bet` pass the path id; `/api/bets/*` omits it and
   * falls back to the currently active round for the mode.
   */
  roundId?: string;
}

export interface PrecisionBetInput {
  address: string;
  amount: number;
  predictedPrice: number;
  /** See {@link UpDownBetInput.roundId}. */
  roundId?: string;
}

export interface BetResult {
  state: string;
  txHash?: string;
  betId: string;
  status: BetStatus;
}

export interface StoredBet {
  id: string;
  userId: string;
  roundId: string | null;
  mode: BetMode;
  side: PredictionSide | null;
  amount: number;
  predictedPrice: number | null;
  status: BetStatus;
  txHash: string | null;
  failureReason: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  resolvedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BetQuery {
  userId?: string;
  roundId?: string;
  status?: BetStatus;
}

export class BetService {
  private isStubMode(): boolean {
    return process.env.BET_STUB_MODE === 'true';
  }

  /**
   * Resolve which round a bet belongs to.
   *
   * When the caller names a round explicitly (round-scoped endpoints such as
   * `POST /api/rounds/:id/bet`) that round must exist and must be for the
   * requested game mode — an unknown or wrong-mode id is a client error rather
   * than a silent fallback onto whatever round happens to be active.
   *
   * When no round is named (`/api/bets/*`), the newest ACTIVE round for the
   * mode is used, and a null result means "no active round" — bets are still
   * recorded so they can be reconciled later.
   */
  private async resolveRoundId(
    tx: Prisma.TransactionClient,
    gameMode: 'UP_DOWN' | 'LEGENDS',
    requestedRoundId?: string
  ): Promise<string | null> {
    if (requestedRoundId) {
      const round = await tx.round.findUnique({
        where: { id: requestedRoundId },
        select: { id: true, mode: true },
      });

      if (!round) {
        throw new NotFoundError(`Round ${requestedRoundId} not found`);
      }

      if (round.mode !== gameMode) {
        throw new ValidationError(
          `Round ${requestedRoundId} is a ${round.mode} round and does not accept ${gameMode} bets`
        );
      }

      return round.id;
    }

    const activeRound = await tx.round.findFirst({
      where: { mode: gameMode, status: 'ACTIVE' },
      orderBy: { startTime: 'desc' },
      select: { id: true },
    });

    return activeRound?.id ?? null;
  }

  async recordUpDownBet(
    input: UpDownBetInput,
    idempotencyKey?: string
  ): Promise<BetResult> {
    const stubMode = this.isStubMode();

    if (stubMode) {
      logger.info('UP/DOWN bet recorded (stub mode)', { ...input, idempotencyKey });
    } else {
      logger.info('Placing UP/DOWN bet on-chain', { ...input, idempotencyKey });
    }

    const result = await prisma.$transaction(async (tx) => {
      const roundId = await this.resolveRoundId(tx, 'UP_DOWN', input.roundId);

      // Create bet record with ACCEPTED status
      const bet = await tx.bet.create({
        data: {
          userId: await this.getOrCreateUserId(tx, input.address),
          roundId,
          mode: BetMode.UP_DOWN,
          side: input.side,
          amount: toDecimal(input.amount),
          status: BetStatus.ACCEPTED,
        },
      });

      let betStatus: BetStatus = BetStatus.ACCEPTED;
      let txHash: string | undefined;
      let chainResult: { state: string; txHash?: string } | null = null;

      if (!stubMode) {
        try {
          chainResult = await sorobanService.placeBet(input.address, input.amount, input.side);
          txHash = chainResult.txHash;

          if (txHash) {
            // Update to SUBMITTED with txHash
            await tx.bet.update({
              where: { id: bet.id },
              data: {
                status: BetStatus.SUBMITTED,
                txHash,
                submittedAt: new Date(),
              },
            });
            betStatus = BetStatus.SUBMITTED;
          } else {
            // No txHash returned - still SUBMITTED but no hash to reconcile against
            await tx.bet.update({
              where: { id: bet.id },
              data: {
                status: BetStatus.SUBMITTED,
                submittedAt: new Date(),
              },
            });
            betStatus = BetStatus.SUBMITTED;
          }
        } catch (error) {
          // Mark as FAILED within the same transaction
          const reason = error instanceof Error ? error.message : String(error);
          await tx.bet.update({
            where: { id: bet.id },
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
              aggregateId: bet.id,
              aggregateType: 'bet',
              payload: {
                betId: bet.id,
                userId: bet.userId,
                roundId: bet.roundId,
                mode: 'UP_DOWN',
                failureReason: reason,
              } satisfies BetFailedOutboxPayload,
            },
          });

          throw error;
        }
      }

      // Write BET_ACCEPTED outbox event atomically with bet creation
      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_ACCEPTED,
          aggregateId: bet.id,
          aggregateType: 'bet',
          payload: {
            betId: bet.id,
            userId: bet.userId,
            roundId: bet.roundId,
            mode: 'UP_DOWN',
            side: input.side,
            amount: input.amount,
            state: stubMode ? 'stub' : 'accepted',
            txHash,
          } satisfies BetAcceptedOutboxPayload,
        },
      });

      const finalBet = await tx.bet.findUnique({ where: { id: bet.id } });
      return { bet: finalBet!, betStatus, txHash, chainResult };
    });

    // Audit event (outside transaction, fire-and-forget)
    betAuditService.emitBetAccepted({
      betId: result.bet.id,
      address: input.address,
      amount: input.amount,
      side: input.side,
      mode: 'UP_DOWN',
      result: stubMode ? 'stub' : 'on-chain-success',
      status: result.betStatus,
      txHash: result.txHash,
    });

    return {
      state: stubMode ? 'stub' : (result.chainResult?.state ?? 'accepted'),
      txHash: result.txHash,
      betId: result.bet.id,
      status: result.betStatus,
    };
  }

  async recordPrecisionBet(
    input: PrecisionBetInput,
    idempotencyKey?: string
  ): Promise<BetResult> {
    const stubMode = this.isStubMode();

    if (stubMode) {
      logger.info('Precision bet recorded (stub mode)', { ...input, idempotencyKey });
    } else {
      logger.info('Placing Precision bet on-chain', { ...input, idempotencyKey });
    }

    const result = await prisma.$transaction(async (tx) => {
      const roundId = await this.resolveRoundId(tx, 'LEGENDS', input.roundId);

      // Create bet record with ACCEPTED status
      const bet = await tx.bet.create({
        data: {
          userId: await this.getOrCreateUserId(tx, input.address),
          roundId,
          mode: BetMode.PRECISION,
          side: null,
          amount: toDecimal(input.amount),
          predictedPrice: toDecimal(input.predictedPrice),
          status: BetStatus.ACCEPTED,
        },
      });

      let betStatus: BetStatus = BetStatus.ACCEPTED;
      let txHash: string | undefined;
      let chainResult: { state: string; txHash?: string } | null = null;

      if (!stubMode) {
        try {
          chainResult = await sorobanService.placePrecisionBet(input.address, input.amount, input.predictedPrice);
          txHash = chainResult.txHash;

          if (txHash) {
            await tx.bet.update({
              where: { id: bet.id },
              data: {
                status: BetStatus.SUBMITTED,
                txHash,
                submittedAt: new Date(),
              },
            });
            betStatus = BetStatus.SUBMITTED;
          } else {
            await tx.bet.update({
              where: { id: bet.id },
              data: {
                status: BetStatus.SUBMITTED,
                submittedAt: new Date(),
              },
            });
            betStatus = BetStatus.SUBMITTED;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await tx.bet.update({
            where: { id: bet.id },
            data: {
              status: BetStatus.FAILED,
              failureReason: reason,
              failedAt: new Date(),
            },
          });

          await tx.outboxEvent.create({
            data: {
              eventType: OutboxEventType.BET_FAILED,
              aggregateId: bet.id,
              aggregateType: 'bet',
              payload: {
                betId: bet.id,
                userId: bet.userId,
                roundId: bet.roundId,
                mode: 'PRECISION',
                failureReason: reason,
              } satisfies BetFailedOutboxPayload,
            },
          });

          throw error;
        }
      }

      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_ACCEPTED,
          aggregateId: bet.id,
          aggregateType: 'bet',
          payload: {
            betId: bet.id,
            userId: bet.userId,
            roundId: bet.roundId,
            mode: 'PRECISION',
            amount: input.amount,
            predictedPrice: input.predictedPrice,
            state: stubMode ? 'stub' : 'accepted',
            txHash,
          } satisfies BetAcceptedOutboxPayload,
        },
      });

      const finalBet = await tx.bet.findUnique({ where: { id: bet.id } });
      return { bet: finalBet!, betStatus, txHash, chainResult };
    });

    betAuditService.emitBetAccepted({
      betId: result.bet.id,
      address: input.address,
      amount: input.amount,
      mode: 'PRECISION',
      result: stubMode ? 'stub' : 'on-chain-success',
      status: result.betStatus,
      txHash: result.txHash,
    });

    return {
      state: stubMode ? 'stub' : (result.chainResult?.state ?? 'accepted'),
      txHash: result.txHash,
      betId: result.bet.id,
      status: result.betStatus,
    };
  }

  /**
   * Attach an on-chain transaction hash to an existing bet record.
   * Used for reconciling SUBMITTED bets (stub→live upgrade or reconciliation job).
   */
  async reconcileBet(betId: string, txHash: string): Promise<StoredBet | null> {
    const bet = await prisma.$transaction(async (tx) => {
      const existingBet = await tx.bet.findUnique({
        where: { id: betId },
      });

      if (!existingBet) {
        logger.warn('Cannot reconcile unknown bet', { betId, txHash });
        return null;
      }

      if (existingBet.status === BetStatus.CONFIRMED && existingBet.txHash === txHash) {
        // Already reconciled - idempotent
        return this.mapBet(existingBet);
      }

      if (existingBet.status === BetStatus.RESOLVED) {
        // Already resolved - don't change status
        logger.info('Bet already resolved, not updating status', { betId, txHash });
        return this.mapBet(existingBet);
      }

      const updatedBet = await tx.bet.update({
        where: { id: betId },
        data: {
          status: BetStatus.CONFIRMED,
          txHash,
          submittedAt: existingBet.submittedAt ?? new Date(),
          confirmedAt: new Date(),
          failureReason: null,
          failedAt: null,
        },
      });

      // Write BET_CONFIRMED outbox event atomically
      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_CONFIRMED,
          aggregateId: betId,
          aggregateType: 'bet',
          payload: {
            betId: updatedBet.id,
            userId: updatedBet.userId,
            roundId: updatedBet.roundId,
            mode: updatedBet.mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
            txHash,
          } satisfies BetConfirmedOutboxPayload,
        },
      });

      return this.mapBet(updatedBet);
    });

    if (bet) {
      logger.info('Bet reconciled with on-chain transaction', {
        betId,
        txHash,
        status: bet.status,
      });

      betAuditService.emitBetReconciled({
        betId: bet.id,
        address: (await prisma.user.findUnique({ where: { id: bet.userId }, select: { walletAddress: true } }))?.walletAddress ?? '',
        amount: toNumber(bet.amount),
        side: bet.side ?? undefined,
        mode: bet.mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
        result: 'reconciled',
        status: bet.status,
        txHash,
      });
    }

    return bet;
  }

  async getBet(betId: string): Promise<StoredBet | null> {
    const bet = await prisma.bet.findUnique({
      where: { id: betId },
    });
    return bet ? this.mapBet(bet) : null;
  }

  async getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    const bets = await prisma.bet.findMany({
      where: {
        userId: query.userId,
        roundId: query.roundId,
        status: query.status,
      },
      orderBy: { createdAt: 'desc' },
    });
    return bets.map(this.mapBet);
  }

  async getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    const counts = await prisma.bet.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const summary: Record<BetStatus, number> = {
      [BetStatus.ACCEPTED]: 0,
      [BetStatus.SUBMITTED]: 0,
      [BetStatus.CONFIRMED]: 0,
      [BetStatus.RESOLVED]: 0,
      [BetStatus.FAILED]: 0,
    };

    for (const c of counts) {
      summary[c.status] = c._count.status;
    }
    return summary;
  }

  /**
   * Marks a bet as resolved with payout information.
   * Called by the resolution pipeline after round resolution.
   */
  async resolveBet(
    betId: string,
    won: boolean,
    payout: number
  ): Promise<StoredBet | null> {
    const bet = await prisma.$transaction(async (tx) => {
      const existingBet = await tx.bet.findUnique({
        where: { id: betId },
      });

      if (!existingBet) {
        logger.warn('Cannot resolve unknown bet', { betId });
        return null;
      }

      if (existingBet.status === BetStatus.RESOLVED) {
        // Already resolved - idempotent
        return existingBet;
      }

      if (existingBet.status !== BetStatus.CONFIRMED) {
        logger.warn('Attempting to resolve bet that is not confirmed', {
          betId,
          currentStatus: existingBet.status,
        });
        // Allow resolution anyway for robustness
      }

      const updatedBet = await tx.bet.update({
        where: { id: betId },
        data: {
          status: BetStatus.RESOLVED,
          resolvedAt: new Date(),
        },
      });

      // Write BET_RESOLVED outbox event atomically
      await tx.outboxEvent.create({
        data: {
          eventType: OutboxEventType.BET_RESOLVED,
          aggregateId: betId,
          aggregateType: 'bet',
          payload: {
            betId: updatedBet.id,
            userId: updatedBet.userId,
            roundId: updatedBet.roundId ?? '',
            mode: updatedBet.mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
            won,
            payout,
          } satisfies BetResolvedOutboxPayload,
        },
      });

      return updatedBet;
    });

    return bet ? this.mapBet(bet) : null;
  }

  /**
   * Marks a bet as failed with a reason.
   * Used for manual failure or irrecoverable errors.
   */
  async failBet(betId: string, reason: string): Promise<StoredBet | null> {
    const bet = await prisma.$transaction(async (tx) => {
      const existingBet = await tx.bet.findUnique({
        where: { id: betId },
      });

      if (!existingBet) {
        logger.warn('Cannot fail unknown bet', { betId });
        return null;
      }

      if (existingBet.status === BetStatus.FAILED) {
        // Already failed - idempotent
        return existingBet;
      }

      if (existingBet.status === BetStatus.RESOLVED) {
        logger.warn('Attempting to fail already resolved bet', { betId });
        return existingBet;
      }

      const updatedBet = await tx.bet.update({
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
            betId: updatedBet.id,
            userId: updatedBet.userId,
            roundId: updatedBet.roundId,
            mode: updatedBet.mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
            failureReason: reason,
          } satisfies BetFailedOutboxPayload,
        },
      });

      return updatedBet;
    });

    if (bet) {
      betAuditService.emitBetFailed({
        betId: bet.id,
        address: (await prisma.user.findUnique({ where: { id: bet.userId }, select: { walletAddress: true } }))?.walletAddress ?? '',
        amount: toNumber(bet.amount),
        side: bet.side ?? undefined,
        mode: bet.mode === BetMode.UP_DOWN ? 'UP_DOWN' : 'PRECISION',
        result: 'manual-failure',
        status: BetStatus.FAILED,
        failureReason: reason,
      });
    }

    return bet ? this.mapBet(bet) : null;
  }

  private async getOrCreateUserId(tx: Prisma.TransactionClient, address: string): Promise<string> {
    let user = await tx.user.findUnique({ where: { walletAddress: address } });
    if (!user) {
      user = await tx.user.create({
        data: { walletAddress: address },
      });
    }
    return user.id;
  }

  private mapBet(bet: any): StoredBet {
    return {
      id: bet.id,
      userId: bet.userId,
      roundId: bet.roundId,
      mode: bet.mode,
      side: bet.side,
      amount: toNumber(bet.amount),
      predictedPrice: bet.predictedPrice ? toNumber(bet.predictedPrice) : null,
      status: bet.status,
      txHash: bet.txHash,
      failureReason: bet.failureReason,
      submittedAt: bet.submittedAt,
      confirmedAt: bet.confirmedAt,
      resolvedAt: bet.resolvedAt,
      failedAt: bet.failedAt,
      createdAt: bet.createdAt,
      updatedAt: bet.updatedAt,
    };
  }

  async claimWinnings(
    address: string,
    idempotencyKey?: string
  ): Promise<{ state: string; amount: number; txHash?: string }> {
    let result: { state: string; amount: number; txHash?: string };

    if (process.env.BET_STUB_MODE === 'true') {
      logger.info('Claim winnings stub recorded', { address, idempotencyKey });
      result = { state: 'stub', amount: 0 };
    } else {
      logger.info('Claiming winnings on-chain', { address, idempotencyKey });
      result = await sorobanService.claimWinnings(address);
    }

    betAuditService.emitClaimAccepted({
      address,
      amount: result.amount,
      result: result.state,
      txHash: result.txHash,
    });

    return result;
  }
}

export default new BetService();