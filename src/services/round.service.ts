import {
  BetMode,
  BetStatus,
  GameMode,
  OutboxEventType,
  PredictionChainStatus,
  Prisma,
  Round,
} from "@prisma/client";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import { prisma } from "../lib/prisma";
import {
  ConflictError,
  IllegalRoundTransitionError,
  NotFoundError,
  ValidationError,
  ErrorCode,
} from "../utils/errors";
import { RoundLifecycleOutcome, RoundStatus } from "../types/round.types";
import roundLifecycleService from "./round-lifecycle.service";
import { Decimal } from "@prisma/client/runtime/library";
import { decAdd, toDecimal, toNumber } from "../utils/decimal.util";
import { roundsStartedTotal } from "../metrics/application.metrics";
import config from "../config";
import {
  ActiveRoundSource,
  mapDatabaseActiveRound,
  mapMockActiveRound,
  mapSorobanActiveRound,
} from "../utils/soroban-round.mapper";
import { getMockRounds } from "../data/mockData";
import type { RoundListItem } from "../repositories/interfaces";

interface LegendsPriceRange {
  min: number;
  max: number;
}

/** Result of an admin cancellation (Issue #977). */
export interface CancelRoundResult {
  outcome:
    | RoundLifecycleOutcome.UPDATED
    | RoundLifecycleOutcome.ALREADY_CANCELLED;
  round: Round | null;
  refundedCount: number;
  refundedTotal: number;
}

/**
 * Postgres advisory-lock key used to serialise concurrent ACTIVE-round starts.
 * A plain `findFirst` + `create` is a TOCTOU race: two admins (or a double
 * submit) can both observe "no active round" and both insert one. The lock is
 * transaction-scoped (`pg_advisory_xact_lock`) and keyed per game mode, so
 * UP_DOWN and LEGENDS rounds may still start independently.
 *
 * Namespace is the ASCII bytes of "XELM"; keys are stable per mode.
 */
const ACTIVE_ROUND_LOCK_NAMESPACE = 0x58454c4d; // 'XELM'
// Plain string keys (still exhaustively type-checked against GameMode) so this
// module-level table does not dereference the runtime enum at import time —
// suites that mock @prisma/client without GameMode can still import the service.
const ACTIVE_ROUND_LOCK_KEY: Record<GameMode, number> = {
  UP_DOWN: 1,
  LEGENDS: 2,
};

export class RoundService {
  /**
   * Starts a new prediction round
   */
  async startRound(
    mode: "UP_DOWN" | "LEGENDS",
    startPrice: number | string | Decimal,
    durationMinutes: number,
    customPriceRanges?: LegendsPriceRange[],
  ): Promise<any> {
    try {
      const gameMode = mode === "UP_DOWN" ? GameMode.UP_DOWN : GameMode.LEGENDS;

      // Check for existing active round of the same mode
      const existingActiveRound = await prisma.round.findFirst({
        where: {
          mode: gameMode,
          status: "ACTIVE",
        },
      });

      if (existingActiveRound) {
        throw new ConflictError(
          `An active ${mode} round already exists (ID: ${existingActiveRound.id})`,
          ErrorCode.ACTIVE_ROUND_EXISTS,
        );
      }

      const startTime = new Date();
      const endTime = new Date(
        startTime.getTime() + durationMinutes * 60 * 1000,
      );

      let sorobanRoundId: string | null = null;

      const startPriceDecimal = toDecimal(startPrice);
      const startPriceNumber = toNumber(startPriceDecimal);

      // Mode 0 (UP_DOWN): Create round on Soroban contract
      if (mode === "UP_DOWN") {
        try {
          await sorobanService.createRound(startPriceDecimal, 0);
        } catch (e) {
          sorobanService.applyMoneyPathFailure("createRound", e);
        }
      }

      // Mode 1 (LEGENDS): Define price ranges
      let priceRanges: any = null;
      if (mode === "LEGENDS") {
        const rangesToUse =
          customPriceRanges && customPriceRanges.length > 0
            ? customPriceRanges
            : this.generateDefaultLegendsRanges(startPriceNumber);

        this.validateLegendsRanges(rangesToUse);

        priceRanges = rangesToUse.map((range) => ({
          min: range.min,
          max: range.max,
          pool: 0,
        }));
      }

      // Create round in database. The check above is a friendly fast-fail;
      // reserveActiveRound performs the authoritative, lock-protected check
      // so two concurrent starts for the same mode cannot both insert a row.
      const round = await this.reserveActiveRound(gameMode, {
        mode: gameMode,
        // Rounds are instantiated directly in ACTIVE (open) state: creation
        // bootstraps the machine rather than transitioning an existing row.
        // Every *transition* out of ACTIVE routes through the lifecycle
        // state machine (round-lifecycle.service).
        status: "ACTIVE" as RoundStatus,
        startTime,
        endTime,
        startPrice: startPriceDecimal,
        sorobanRoundId,
        isSoroban: mode === "UP_DOWN" && sorobanService.isReady(),
        priceRanges: priceRanges
          ? JSON.parse(JSON.stringify(priceRanges))
          : null,
      });

      logger.info(
        `Round created: ${round.id}, mode=${mode}, sorobanId=${sorobanRoundId}`,
      );
      roundsStartedTotal.inc({ mode });

      // Emit round started event
      websocketService.emitRoundStarted(round);

      // Create and broadcast ROUND_START notification to all users
      try {
        const users = await prisma.user.findMany({
          select: { id: true },
        });

        for (const user of users) {
          const notif = await notificationService.createNotification({
            userId: user.id,
            type: "ROUND_START",
            title: "New Round Started!",
            message: `A new ${mode === "UP_DOWN" ? "Up/Down" : "Legends"} round has started! Place your prediction now. Starting price: $${startPriceDecimal.toFixed(4)}`,
            data: { roundId: round.id, startPrice: startPriceNumber },
          });

          if (notif) {
            websocketService.emitNotification(user.id, notif);
          }
        }
      } catch (error) {
        logger.error("Failed to send round start notifications:", error);
        // Don't throw - let the round creation succeed even if notifications fail
      }

      return round;
    } catch (error) {
      logger.error("Failed to start round:", error);
      throw error;
    }
  }

  /**
   * Atomically reserve the single ACTIVE slot for a game mode.
   *
   * The advisory lock serialises concurrent transactions for the same mode;
   * the re-check inside the transaction is authoritative (the earlier check in
   * `startRound` is only a fast-fail). A loser of the race gets the same 409
   * ConflictError as the sequential path, so callers see one consistent
   * contract regardless of how the race resolves.
   */
  private async reserveActiveRound(
    mode: GameMode,
    data: Prisma.RoundUncheckedCreateInput,
  ): Promise<Round> {
    return prisma.$transaction(async (tx) => {
      // Prisma binds JS numbers as bigint; the two-argument advisory-lock
      // function is `(int4, int4)`, so cast explicitly.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACTIVE_ROUND_LOCK_NAMESPACE}::int, ${ACTIVE_ROUND_LOCK_KEY[mode]}::int)`;

      const active = await tx.round.findFirst({
        where: { mode, status: "ACTIVE" },
        select: { id: true },
      });

      if (active) {
        throw new ConflictError(
          `An active ${mode} round already exists (ID: ${active.id})`,
          ErrorCode.ACTIVE_ROUND_EXISTS,
        );
      }

      return tx.round.create({ data });
    });
  }

  /**
   * Gets a round by ID
   */
  async getRound(roundId: string): Promise<any> {
    try {
      const round = await prisma.round.findUnique({
        where: { id: roundId },
        include: {
          predictions: {
            include: {
              user: {
                select: {
                  id: true,
                  walletAddress: true,
                },
              },
            },
          },
        },
      });

      return round;
    } catch (error) {
      logger.error("Failed to get round:", error);
      throw error;
    }
  }

  /**
   * Shared entrypoint for round listing across all API entrypoints.
   *
   * Fallback chain: Soroban → Database → Mock.
   * Set ROUNDS_MOCK_MODE=true to skip Soroban and go directly to mock data.
   *
   * Every stage is wrapped in try-catch so a failure at any level degrades
   * gracefully to the next fallback. The source field tells callers which
   * backend produced the data.
   */
  async getRoundsForApi(): Promise<{
    source: ActiveRoundSource;
    rounds: RoundListItem[];
  }> {
    if (config.app.roundsMockMode) {
      return { source: "mock", rounds: await this.getMockRoundsForApi() };
    }

    // 1. Try Soroban on-chain round
    try {
      const onChainRound = await sorobanService.getActiveRound();
      if (onChainRound) {
        return {
          source: "soroban",
          rounds: [mapSorobanActiveRound(onChainRound)],
        };
      }
    } catch (error) {
      logger.warn("Soroban fetch failed; falling back to database", {
        error: (error as Error).message,
      });
    }

    // 2. Try database rounds
    try {
      const dbRounds = await this.getActiveRounds();
      if (dbRounds.length > 0) {
        return {
          source: "database",
          rounds: dbRounds.map((round) => mapDatabaseActiveRound(round)),
        };
      }
    } catch (error) {
      logger.warn("Database fetch failed; falling back to mock data", {
        error: (error as Error).message,
      });
    }

    // 3. Ultimate fallback — mock data
    return { source: "mock", rounds: await this.getMockRoundsForApi() };
  }

  /**
   * Mock rounds tagged with `source: "mock"`, so callers can identify the
   * origin of an individual round the same way they can for the soroban and
   * database tiers.
   */
  private async getMockRoundsForApi(): Promise<RoundListItem[]> {
    const rounds = await getMockRounds();
    return rounds.map((round) =>
      mapMockActiveRound(round as Record<string, unknown>),
    );
  }

  /**
   * @deprecated Use {@link getRoundsForApi} instead. Kept for backward
   * compatibility. Delegates to getRoundsForApi.
   */
  async getActiveRoundsWithFallback(): Promise<{
    source: ActiveRoundSource;
    rounds: RoundListItem[];
  }> {
    return this.getRoundsForApi();
  }

  /**
   * Gets all active rounds
   */
  async getActiveRounds(): Promise<Round[]> {
    try {
      const rounds = await prisma.round.findMany({
        where: {
          status: "ACTIVE",
        },
        orderBy: {
          startTime: "desc",
        },
      });

      return rounds;
    } catch (error) {
      logger.error("Failed to get active rounds:", error);
      throw error;
    }
  }

  /**
   * Locks a round (no more predictions allowed).
   *
   * Delegates the actual status write to the lifecycle state machine so the
   * illegal-transition guard is enforced in one place (round-lifecycle.service).
   * Returns an outcome for the scheduler callers while still throwing on truly
   * illegal hops (e.g. locking a round that was never ACTIVE).
   */
  async lockRound(roundId: string): Promise<RoundLifecycleOutcome> {
    try {
      // Reuse the state-machine's outcome mapping (NOW_OP for missing/final
      // rounds, ALREADY_LOCKED for idempotent locks, UPDATED otherwise).
      return await roundLifecycleService.lockRound(roundId);
    } catch (error) {
      logger.error("Failed to lock round:", error);
      throw error;
    }
  }

  /**
   * Admin cancellation with full participant refunds (Issue #977).
   *
   * The whole operation — lifecycle transition, prediction/bet refunds,
   * balance credits and outbox writes — runs in one Prisma transaction, so a
   * crash or any write failure rolls the cancellation back completely.
   *
   * Idempotency is derived from the round status, not a separate key:
   *   - CANCELLED  → return ALREADY_CANCELLED without refunding again
   *   - RESOLVED   → reject (a settled round cannot be cancelled)
   *   - ACTIVE/LOCKED → cancel once; a concurrent loser of the compare-and-set
   *     transition is folded into the ALREADY_CANCELLED outcome
   *
   * Only settled participants are refunded: predictions in CONFIRMED or
   * NOT_REQUIRED chain state, and their CONFIRMED bets. Predictions/bets still
   * in flight on-chain are deliberately excluded — their chain settlement is
   * outside this transaction and cannot be rolled back here.
   */
  async cancelRound(roundId: string): Promise<CancelRoundResult> {
    const settledPredictions = {
      where: {
        chainStatus: {
          in: [
            PredictionChainStatus.CONFIRMED,
            PredictionChainStatus.NOT_REQUIRED,
          ],
        },
      },
    };

    try {
      // Fast-fail outside the transaction before opening a DB transaction.
      const existing = await prisma.round.findUnique({
        where: { id: roundId },
        include: { predictions: settledPredictions },
      });

      if (!existing) {
        throw new NotFoundError(`Round not found: ${roundId}`);
      }
      if (existing.status === "RESOLVED") {
        throw new ConflictError(
          "Cannot cancel a resolved round",
          ErrorCode.ROUND_ALREADY_RESOLVED,
        );
      }
      if (existing.status === "CANCELLED") {
        return {
          outcome: RoundLifecycleOutcome.ALREADY_CANCELLED,
          round: existing,
          refundedCount: 0,
          refundedTotal: 0,
        };
      }
      if (existing.status !== "ACTIVE" && existing.status !== "LOCKED") {
        throw new ConflictError(
          `Cannot cancel a ${existing.status} round`,
          ErrorCode.CONFLICT,
        );
      }

      const result = await prisma.$transaction(async (tx) => {
        // Authoritative re-check: the state machine's conditional UPDATE is
        // the compare-and-set that serialises concurrent admin cancels.
        const round = await tx.round.findUnique({
          where: { id: roundId },
          include: { predictions: settledPredictions },
        });

        if (!round) {
          throw new NotFoundError(`Round not found: ${roundId}`);
        }
        if (round.status === "RESOLVED") {
          throw new ConflictError(
            "Cannot cancel a resolved round",
            ErrorCode.ROUND_ALREADY_RESOLVED,
          );
        }
        if (round.status === "CANCELLED") {
          return {
            outcome: RoundLifecycleOutcome.ALREADY_CANCELLED as const,
            round: round as Round,
            refundedCount: 0,
            refundedTotal: 0,
          };
        }
        if (round.status !== "ACTIVE" && round.status !== "LOCKED") {
          throw new ConflictError(
            `Cannot cancel a ${round.status} round`,
            ErrorCode.CONFLICT,
          );
        }

        // Claim the round before any refund write. If another cancel wins the
        // race this throws IllegalRoundTransitionError and the transaction
        // rolls back with no balance credits or outbox rows.
        const cancelled = await roundLifecycleService.transitionRound(
          roundId,
          "CANCELLED",
          { tx },
          false,
        );

        const now = new Date();
        let refundedCount = 0;
        let refundTotal = toDecimal(0);

        for (const prediction of round.predictions) {
          const amount = toDecimal(prediction.amount);
          const refundAmount = toNumber(amount);

          await tx.prediction.update({
            where: { id: prediction.id },
            data: { won: null, payout: refundAmount },
          });
          await tx.user.update({
            where: { id: prediction.userId },
            data: { virtualBalance: { increment: refundAmount } },
          });

          // Resolve confirmed bets inline: betService.resolveBet opens its own
          // transaction, which cannot be nested inside this one. The BET_RESOLVED
          // outbox row mirrors the bet service's payload so the poller sees an
          // identical event shape.
          const bets = await tx.bet.findMany({
            where: {
              userId: prediction.userId,
              roundId,
              status: BetStatus.CONFIRMED,
            },
          });

          for (const bet of bets) {
            await tx.bet.update({
              where: { id: bet.id },
              data: { status: BetStatus.RESOLVED, resolvedAt: now },
            });
            await tx.outboxEvent.create({
              data: {
                eventType: OutboxEventType.BET_RESOLVED,
                aggregateId: bet.id,
                aggregateType: "bet",
                payload: {
                  betId: bet.id,
                  userId: bet.userId,
                  roundId,
                  mode:
                    bet.mode === BetMode.UP_DOWN ? "UP_DOWN" : "PRECISION",
                  won: false,
                  payout: refundAmount,
                  reason: "ROUND_CANCELLED",
                },
              },
            });
          }

          const message = `Round #${roundId.slice(0, 6)} was cancelled. ${refundAmount.toFixed(8)} XLM was refunded to your balance.`;
          await tx.outboxEvent.create({
            data: {
              eventType: OutboxEventType.NOTIFICATION_CREATE,
              aggregateId: roundId,
              aggregateType: "round",
              payload: {
                userId: prediction.userId,
                type: "REFUND",
                title: "Round Cancelled — Prediction Refunded",
                message,
                data: { roundId, amount: refundAmount },
              },
            },
          });
          await tx.outboxEvent.create({
            data: {
              eventType: OutboxEventType.WEBSOCKET_EMIT,
              aggregateId: roundId,
              aggregateType: "round",
              payload: {
                eventName: "notification:new",
                room: `user:${prediction.userId}`,
                data: {
                  type: "REFUND",
                  title: "Round Cancelled — Prediction Refunded",
                  message,
                  data: { roundId, amount: refundAmount },
                  isRead: false,
                },
              },
            },
          });

          refundedCount += 1;
          refundTotal = decAdd(refundTotal, amount);
        }

        // Always emit one round-level outbox event, including the no-participant
        // case, so cancellation is durable and replayable by the outbox poller.
        await tx.outboxEvent.create({
          data: {
            eventType: OutboxEventType.WEBSOCKET_EMIT,
            aggregateId: roundId,
            aggregateType: "round",
            payload: {
              eventName: "round:cancelled",
              room: `round:${roundId}`,
              data: { roundId, status: "CANCELLED", refundedCount },
            },
          },
        });

        return {
          outcome: RoundLifecycleOutcome.UPDATED as const,
          round: { ...cancelled, predictions: round.predictions } as Round,
          refundedCount,
          refundedTotal: toNumber(refundTotal),
        };
      });

      websocketService.emitRoundUpdate(result.round);
      logger.info(
        `Round ${roundId} cancelled: refunded ${result.refundedCount} prediction(s), ${result.refundedTotal} XLM`,
      );
      return result;
    } catch (error) {
      // A concurrent cancel can lose the compare-and-set after both callers
      // passed the status checks. The winner already performed the refunds,
      // so report the idempotent outcome instead of double-crediting.
      if (error instanceof IllegalRoundTransitionError) {
        const current = await prisma.round.findUnique({
          where: { id: roundId },
        });
        if (current?.status === "CANCELLED") {
          return {
            outcome: RoundLifecycleOutcome.ALREADY_CANCELLED,
            round: current,
            refundedCount: 0,
            refundedTotal: 0,
          };
        }
      }

      logger.error("Failed to cancel round:", error);
      throw error;
    }
  }

  /**
   * Checks if a round should be auto-locked based on time
   */
  async autoLockExpiredRounds(): Promise<void> {
    try {
      const now = new Date();

      const expiredRounds = await prisma.round.findMany({
        where: {
          status: "ACTIVE",
          endTime: {
            lte: now,
          },
        },
      });

      let updatedCount = 0;
      for (const round of expiredRounds) {
        const outcome = await this.lockRound(round.id);
        if (outcome === RoundLifecycleOutcome.UPDATED) {
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        logger.info(`Auto-locked ${updatedCount} expired rounds`);
      }
    } catch (error) {
      logger.error("Failed to auto-lock expired rounds:", error);
    }
  }

  /**
   * Gets historical rounds with pagination and aggregate stats
   */
  async getRoundsHistory(options: {
    limit?: number;
    offset?: number;
    mode?: "UP_DOWN" | "LEGENDS";
    status?: "RESOLVED" | "CANCELLED";
  }): Promise<{
    rounds: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      const limit = Math.min(options.limit ?? 20, 100);
      const offset = options.offset ?? 0;

      // Build where clause for historical rounds (RESOLVED or CANCELLED)
      const where: any = {
        status: {
          in: ["RESOLVED", "CANCELLED"],
        },
      };

      // Apply optional filters
      if (options.mode) {
        where.mode = options.mode;
      }

      if (options.status) {
        where.status = options.status;
      }

      // Get total count for pagination
      const total = await prisma.round.count({ where });

      // Get rounds with predictions for aggregate stats
      const rounds = await prisma.round.findMany({
        where,
        orderBy: {
          updatedAt: "desc",
        },
        skip: offset,
        take: limit,
        include: {
          predictions: {
            select: {
              amount: true,
              won: true,
            },
          },
        },
      });

      // Transform rounds to include aggregate stats
      const roundsWithStats = rounds.map((round: any) => {
        const totalPredictions = round.predictions.length;
        const totalPool = round.predictions.reduce(
          (sum: number, p: any) => sum + p.amount,
          0,
        );
        const winnerCount = round.predictions.filter(
          (p: any) => p.won === true,
        ).length;

        // Remove predictions array and add aggregate stats
        const { predictions, ...roundData } = round;

        return {
          ...roundData,
          totalPredictions,
          totalPool: totalPool.toFixed(2),
          winnerCount,
        };
      });

      return {
        rounds: roundsWithStats,
        total,
        limit,
        offset,
      };
    } catch (error) {
      logger.error("Failed to get rounds history:", error);
      throw error;
    }
  }

  private generateDefaultLegendsRanges(
    startPrice: number,
  ): LegendsPriceRange[] {
    const rangeWidth = startPrice * 0.05;
    return [
      { min: startPrice - rangeWidth * 2, max: startPrice - rangeWidth },
      { min: startPrice - rangeWidth, max: startPrice },
      { min: startPrice, max: startPrice + rangeWidth },
      { min: startPrice + rangeWidth, max: startPrice + rangeWidth * 2 },
      { min: startPrice + rangeWidth * 2, max: startPrice + rangeWidth * 3 },
    ];
  }

  private validateLegendsRanges(ranges: LegendsPriceRange[]): void {
    if (!Array.isArray(ranges) || ranges.length < 2) {
      throw new ValidationError("LEGENDS requires at least 2 price ranges");
    }

    const sorted = [...ranges].sort((a, b) => a.min - b.min);

    for (let i = 0; i < sorted.length; i++) {
      const range = sorted[i];

      if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
        throw new ValidationError(
          "Each LEGENDS price range must contain finite numeric min/max values",
        );
      }

      if (range.min >= range.max) {
        throw new ValidationError(
          "Each LEGENDS price range must satisfy min < max",
        );
      }

      if (i > 0) {
        const prev = sorted[i - 1];
        if (range.min < prev.max) {
          throw new ValidationError("LEGENDS price ranges must not overlap");
        }
      }
    }
  }
}

export default new RoundService();
