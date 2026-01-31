import { PrismaClient, GameMode as PrismaGameMode, RoundStatus } from "@prisma/client";
import sorobanService, { BlockchainError, BlockchainErrorType } from "../services/soroban.service";
import websocketService from "../services/websocket.service";
import notificationService from "../services/notification.service";
import logger from "../utils/logger";

const prisma = new PrismaClient();

/**
 * Round service error for application-level failures
 */
export class RoundServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "RoundServiceError";
    Object.setPrototypeOf(this, RoundServiceError.prototype);
  }
}

export class RoundService {
  /**
   * ORIGINAL + ENHANCED: Start a new prediction round
   * Now includes blockchain integration with rollback on failure
   */
  async startRound(
    mode: "UP_DOWN" | "LEGENDS",
    startPrice: number,
    durationMinutes: number
  ): Promise<any> {
    const operationStart = Date.now();
    let dbRoundId: string | null = null;
    let blockchainTxHash: string | null = null;

    try {
      // Validate inputs
      if (startPrice <= 0) {
        throw new RoundServiceError(
          "Start price must be positive",
          "INVALID_START_PRICE",
          400
        );
      }

      if (durationMinutes <= 0 || durationMinutes > 1440) {
        throw new RoundServiceError(
          "Duration must be between 1 and 1440 minutes (24 hours)",
          "INVALID_DURATION",
          400
        );
      }

      if (mode !== "UP_DOWN" && mode !== "LEGENDS") {
        throw new RoundServiceError(
          "Mode must be UP_DOWN or LEGENDS",
          "INVALID_MODE",
          400
        );
      }

      // Check if LEGENDS mode
      if (mode === "LEGENDS") {
        throw new RoundServiceError(
          "LEGENDS mode is not yet supported by the smart contract",
          "LEGENDS_NOT_IMPLEMENTED",
          501
        );
      }

      // ORIGINAL: Check if there's already an active round
      const existingActiveRound = await prisma.round.findFirst({
        where: {
          status: RoundStatus.ACTIVE,
        },
      });

      if (existingActiveRound) {
        throw new RoundServiceError(
          `An active round already exists: ${existingActiveRound.id}`,
          "ACTIVE_ROUND_EXISTS",
          409
        );
      }

      // ORIGINAL: Calculate times
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

      const gameMode: PrismaGameMode = mode === "UP_DOWN" ? "UP_DOWN" : "LEGENDS";

      // ORIGINAL: Generate price ranges for LEGENDS mode
      let priceRanges: any = null;
      if (mode !== "UP_DOWN") {
        const rangeWidth = startPrice * 0.05;
        priceRanges = [
          {
            min: startPrice - rangeWidth * 2,
            max: startPrice - rangeWidth,
            pool: 0,
          },
          { min: startPrice - rangeWidth, max: startPrice, pool: 0 },
          { min: startPrice, max: startPrice + rangeWidth, pool: 0 },
          {
            min: startPrice + rangeWidth,
            max: startPrice + rangeWidth * 2,
            pool: 0,
          },
          {
            min: startPrice + rangeWidth * 2,
            max: startPrice + rangeWidth * 3,
            pool: 0,
          },
        ];
      }

      // Step 1: Create round in database with PENDING status (ENHANCED)
      logger.info("Creating round in database", {
        mode,
        startPrice,
        durationMinutes,
      });

      const dbRound = await prisma.round.create({
        data: {
          mode: gameMode,
          status: RoundStatus.PENDING, // ENHANCED: Start as PENDING until blockchain confirms
          startTime,
          endTime,
          startPrice,
          poolUp: 0,
          poolDown: 0,
          priceRanges: priceRanges ? JSON.parse(JSON.stringify(priceRanges)) : null,
        },
      });

      dbRoundId = dbRound.id;

      logger.info("Database round created", {
        roundId: dbRoundId,
        status: "PENDING",
      });

      // Step 2: NEW - Create round on blockchain (if Soroban is enabled)
      if (sorobanService.isInitialized()) {
        try {
          logger.info("Creating round on blockchain", {
            roundId: dbRoundId,
            startPrice,
            durationMinutes,
          });

          // Convert duration to ledgers (~5 seconds per ledger)
          const durationLedgers = Math.floor((durationMinutes * 60) / 5);
          const modeNum = mode === "UP_DOWN" ? 0 : 1;

          blockchainTxHash = await sorobanService.createRound(
            startPrice,
            durationLedgers,
            modeNum
          );

          logger.info("Blockchain round created", {
            roundId: dbRoundId,
            txHash: blockchainTxHash,
          });
        } catch (blockchainError: any) {
          // NEW: Blockchain creation failed - rollback database
          logger.error("Blockchain round creation failed, rolling back", {
            roundId: dbRoundId,
            error: blockchainError.message,
            errorType: blockchainError.type,
          });

          await this.rollbackRound(dbRoundId, "Blockchain creation failed");

          // Re-throw blockchain error
          throw blockchainError;
        }
      } else {
        logger.warn("Soroban service not initialized, round created in database only", {
          roundId: dbRoundId,
        });
      }

      // Step 3: Update database round with blockchain info and ACTIVE status
      const updatedRound = await prisma.round.update({
        where: { id: dbRoundId },
        data: {
          status: RoundStatus.ACTIVE,
          sorobanRoundId: blockchainTxHash,
        },
      });

      const duration = Date.now() - operationStart;

      logger.info("Round started successfully", {
        roundId: updatedRound.id,
        mode,
        startPrice,
        endTime,
        txHash: blockchainTxHash,
        durationMs: duration,
      });

      // ORIGINAL: Emit round started event via WebSocket
      try {
        websocketService.emitRoundStarted(updatedRound);
      } catch (wsError: any) {
        logger.warn("Failed to emit round started event", {
          roundId: updatedRound.id,
          error: wsError.message,
        });
      }

      // ORIGINAL: Send notifications to users
      try {
        await this.notifyRoundStart(updatedRound);
      } catch (notifError: any) {
        logger.warn("Failed to send round start notifications", {
          roundId: updatedRound.id,
          error: notifError.message,
        });
      }

      return updatedRound;
    } catch (error: any) {
      const duration = Date.now() - operationStart;

      logger.error("Failed to start round", {
        mode,
        startPrice,
        durationMinutes,
        error: error.message,
        errorType: error.type || error.name,
        durationMs: duration,
        dbRoundId,
        blockchainTxHash,
      });

      // If it's already a known error type, re-throw
      if (error instanceof RoundServiceError || error instanceof BlockchainError) {
        throw error;
      }

      // Otherwise wrap in service error
      throw new RoundServiceError(
        `Failed to start round: ${error.message}`,
        "ROUND_START_FAILED",
        500
      );
    }
  }

  /**
   * NEW: Rollback a round by marking it as CANCELLED
   */
  private async rollbackRound(roundId: string, reason: string): Promise<void> {
    try {
      await prisma.round.update({
        where: { id: roundId },
        data: {
          status: RoundStatus.CANCELLED,
        },
      });

      logger.info("Round rolled back successfully", {
        roundId,
        reason,
      });
    } catch (rollbackError: any) {
      logger.error("CRITICAL: Failed to rollback round", {
        roundId,
        reason,
        rollbackError: rollbackError.message,
      });

      throw new Error(
        `Critical: Failed to rollback round ${roundId}: ${rollbackError.message}`
      );
    }
  }

  /**
   * ORIGINAL: Send notifications to all users about round start
   */
  private async notifyRoundStart(round: any): Promise<void> {
    try {
      const users = await prisma.user.findMany({
        select: { id: true },
      });

      const modeName = round.mode === "UP_DOWN" ? "Up/Down" : "Legends";

      const notificationPromises = users.map(async (user) => {
        try {
          const notif = await notificationService.createNotification({
            userId: user.id,
            type: "ROUND_START",
            title: "New Round Started!",
            message: `A new ${modeName} round has started! Place your prediction now. Starting price: $${round.startPrice.toFixed(4)}`,
            data: {
              roundId: round.id,
              startPrice: round.startPrice,
              endTime: round.endTime.toISOString(),
            },
          });

          if (notif) {
            websocketService.emitNotification(user.id, notif);
          }
        } catch (userNotifError: any) {
          logger.warn("Failed to send notification to user", {
            userId: user.id,
            roundId: round.id,
            error: userNotifError.message,
          });
        }
      });

      await Promise.allSettled(notificationPromises);

      logger.info("Round start notifications sent", {
        roundId: round.id,
        userCount: users.length,
      });
    } catch (error: any) {
      logger.error("Failed to send round start notifications", {
        roundId: round.id,
        error: error.message,
      });
    }
  }

  /**
   * ORIGINAL: Get a round by ID
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

      if (!round) {
        throw new RoundServiceError("Round not found", "ROUND_NOT_FOUND", 404);
      }

      return round;
    } catch (error: any) {
      logger.error("Failed to get round", {
        roundId,
        error: error.message,
      });

      if (error instanceof RoundServiceError) {
        throw error;
      }

      throw new RoundServiceError(
        `Failed to get round: ${error.message}`,
        "ROUND_FETCH_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Get all active rounds
   */
  async getActiveRounds(): Promise<any[]> {
    try {
      const rounds = await prisma.round.findMany({
        where: {
          status: RoundStatus.ACTIVE,
        },
        orderBy: {
          startTime: "desc",
        },
        include: {
          predictions: {
            select: {
              amount: true,
              side: true,
            },
          },
        },
      });

      return rounds;
    } catch (error: any) {
      logger.error("Failed to get active rounds", {
        error: error.message,
      });

      throw new RoundServiceError(
        `Failed to get active rounds: ${error.message}`,
        "ACTIVE_ROUNDS_FETCH_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Lock a round (no more predictions allowed)
   */
  async lockRound(roundId: string): Promise<void> {
    try {
      const round = await prisma.round.findUnique({
        where: { id: roundId },
      });

      if (!round) {
        throw new RoundServiceError("Round not found", "ROUND_NOT_FOUND", 404);
      }

      if (round.status !== RoundStatus.ACTIVE) {
        throw new RoundServiceError(
          "Only active rounds can be locked",
          "INVALID_ROUND_STATUS",
          400
        );
      }

      await prisma.round.update({
        where: { id: roundId },
        data: { status: RoundStatus.LOCKED },
      });

      logger.info("Round locked", { roundId });
    } catch (error: any) {
      logger.error("Failed to lock round", {
        roundId,
        error: error.message,
      });

      if (error instanceof RoundServiceError) {
        throw error;
      }

      throw new RoundServiceError(
        `Failed to lock round: ${error.message}`,
        "ROUND_LOCK_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Auto-lock expired rounds
   */
  async autoLockExpiredRounds(): Promise<number> {
    try {
      const now = new Date();

      const expiredRounds = await prisma.round.findMany({
        where: {
          status: RoundStatus.ACTIVE,
          endTime: {
            lte: now,
          },
        },
      });

      if (expiredRounds.length === 0) {
        return 0;
      }

      logger.info(`Auto-locking ${expiredRounds.length} expired rounds`);

      const lockPromises = expiredRounds.map((round) =>
        this.lockRound(round.id).catch((error) => {
          logger.error("Failed to auto-lock round", {
            roundId: round.id,
            error: error.message,
          });
        })
      );

      await Promise.allSettled(lockPromises);

      logger.info(`Auto-locked ${expiredRounds.length} rounds`);

      return expiredRounds.length;
    } catch (error: any) {
      logger.error("Failed to auto-lock expired rounds", {
        error: error.message,
      });

      return 0;
    }
  }

  /**
   * ORIGINAL: Get rounds history with pagination
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

      const where: any = {
        status: {
          in: [RoundStatus.RESOLVED, RoundStatus.CANCELLED],
        },
      };

      if (options.mode) {
        where.mode = options.mode === "UP_DOWN" ? "UP_DOWN" : "LEGENDS";
      }

      if (options.status) {
        where.status = options.status === "RESOLVED" ? RoundStatus.RESOLVED : RoundStatus.CANCELLED;
      }

      const [total, rounds] = await Promise.all([
        prisma.round.count({ where }),
        prisma.round.findMany({
          where,
          orderBy: {
            createdAt: "desc",
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
        }),
      ]);

      const roundsWithStats = rounds.map((round: any) => {
        const totalPredictions = round.predictions.length;
        const totalPool = round.predictions.reduce(
          (sum: number, p: any) => sum + p.amount,
          0
        );
        const winnerCount = round.predictions.filter(
          (p: any) => p.won === true
        ).length;

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
    } catch (error: any) {
      logger.error("Failed to get rounds history", {
        error: error.message,
      });

      throw new RoundServiceError(
        `Failed to get rounds history: ${error.message}`,
        "ROUNDS_HISTORY_FETCH_FAILED",
        500
      );
    }
  }

  /**
   * NEW: Cancel a round (admin only) - Refunds all predictions
   */
  async cancelRound(roundId: string, reason: string): Promise<void> {
    try {
      const round = await prisma.round.findUnique({
        where: { id: roundId },
        include: {
          predictions: true,
        },
      });

      if (!round) {
        throw new RoundServiceError("Round not found", "ROUND_NOT_FOUND", 404);
      }

      if (round.status === RoundStatus.RESOLVED || round.status === RoundStatus.CANCELLED) {
        throw new RoundServiceError(
          "Cannot cancel resolved or already cancelled round",
          "INVALID_ROUND_STATUS",
          400
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.round.update({
          where: { id: roundId },
          data: { status: RoundStatus.CANCELLED },
        });

        for (const prediction of round.predictions) {
          await tx.user.update({
            where: { id: prediction.userId },
            data: {
              virtualBalance: {
                increment: prediction.amount,
              },
            },
          });

          await tx.transaction.create({
            data: {
              userId: prediction.userId,
              amount: prediction.amount,
              type: "BONUS",
              description: `Refund from cancelled round: ${reason}`,
              roundId,
            },
          });
        }
      });

      logger.info("Round cancelled and refunds processed", {
        roundId,
        reason,
        refundCount: round.predictions.length,
      });
    } catch (error: any) {
      logger.error("Failed to cancel round", {
        roundId,
        reason,
        error: error.message,
      });

      if (error instanceof RoundServiceError) {
        throw error;
      }

      throw new RoundServiceError(
        `Failed to cancel round: ${error.message}`,
        "ROUND_CANCEL_FAILED",
        500
      );
    }
  }
}

export default new RoundService();