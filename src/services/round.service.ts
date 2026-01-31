import { PrismaClient, GameMode, RoundStatus } from "@prisma/client";
import sorobanService, { BlockchainError, BlockchainErrorType } from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
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
   * ORIGINAL + ENHANCED: Starts a new prediction round
   * Now includes blockchain integration with rollback on failure
   */
  async startRound(
    mode: "UP_DOWN" | "LEGENDS",
    startPrice: number,
    durationMinutes: number,
  ): Promise<any> {
    const operationStart = Date.now();
    let dbRoundId: string | null = null;
    let blockchainTxHash: string | null = null;

    try {
      // ENHANCED: Validate inputs
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

      // ENHANCED: Check if LEGENDS mode (not yet supported by blockchain)
      if (mode === "LEGENDS") {
        throw new RoundServiceError(
          "LEGENDS mode is not yet supported by the smart contract",
          "LEGENDS_NOT_IMPLEMENTED",
          501
        );
      }

      // ENHANCED: Check if there's already an active round
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
      const gameMode = mode === "UP_DOWN" ? 0 : 1;
      const startTime = new Date();
      const endTime = new Date(
        startTime.getTime() + durationMinutes * 60 * 1000,
      );

      // ORIGINAL: Mode 1 (LEGENDS): Define price ranges
      let priceRanges: any = null;
      if (mode !== "UP_DOWN") {
        // Create 5 price ranges around the current price
        const rangeWidth = startPrice * 0.05; // 5% range width
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

      // Step 1: ENHANCED - Create round in database with PENDING status first
      logger.info("Creating round in database", {
        mode,
        startPrice,
        durationMinutes,
      });

      const dbRound = await prisma.round.create({
        data: {
          mode: gameMode === 0 ? "UP_DOWN" : "LEGENDS",
          status: RoundStatus.PENDING, // ENHANCED: Start as PENDING until blockchain confirms
          startTime,
          endTime,
          startPrice,
          priceRanges: priceRanges
            ? JSON.parse(JSON.stringify(priceRanges))
            : null,
        },
      });

      dbRoundId = dbRound.id;

      logger.info("Database round created", {
        roundId: dbRoundId,
        status: "PENDING",
      });

      // Step 2: ENHANCED - Create round on Soroban contract (if enabled)
      if (mode === "UP_DOWN") {
        if (sorobanService.isInitialized()) {
          try {
            logger.info("Creating round on blockchain", {
              roundId: dbRoundId,
              startPrice,
              durationMinutes,
            });

            // Convert duration to ledgers (~5 seconds per ledger)
            const durationLedgers = Math.floor((durationMinutes * 60) / 5);
            
            blockchainTxHash = await sorobanService.createRound(
              startPrice,
              durationLedgers,
              gameMode
            );

            logger.info("Blockchain round created", {
              roundId: dbRoundId,
              txHash: blockchainTxHash,
            });
          } catch (blockchainError: any) {
            // ENHANCED: Blockchain creation failed - rollback database
            logger.error("Blockchain round creation failed, rolling back", {
              roundId: dbRoundId,
              error: blockchainError.message,
              errorType: blockchainError.type,
            });

            await this.rollbackRound(dbRoundId, "Blockchain creation failed");

            // Re-throw blockchain error for route to handle
            throw blockchainError;
          }
        } else {
          logger.warn("Soroban service not initialized, round created in database only", {
            roundId: dbRoundId,
          });
        }
      }

      // Step 3: Update round to ACTIVE status with blockchain info
      const round = await prisma.round.update({
        where: { id: dbRoundId },
        data: {
          status: RoundStatus.ACTIVE,
          sorobanRoundId: blockchainTxHash,
        },
      });

      const duration = Date.now() - operationStart;

      logger.info("Round started successfully", {
        roundId: round.id,
        mode,
        startPrice,
        endTime,
        txHash: blockchainTxHash,
        durationMs: duration,
      });

      // ORIGINAL: Emit round started event
      try {
        websocketService.emitRoundStarted(round);
      } catch (wsError: any) {
        logger.warn("Failed to emit round started event", {
          roundId: round.id,
          error: wsError.message,
        });
      }

      // ORIGINAL: Create and broadcast ROUND_START notification to all users
      try {
        const users = await prisma.user.findMany({
          select: { id: true },
        });

        for (const user of users) {
          const notif = await notificationService.createNotification({
            userId: user.id,
            type: "ROUND_START",
            title: "New Round Started!",
            message: `A new ${mode === "UP_DOWN" ? "Up/Down" : "Legends"} round has started! Place your prediction now. Starting price: $${startPrice.toFixed(4)}`,
            data: { roundId: round.id, startPrice },
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

      // This is critical - we have inconsistent state
      throw new Error(
        `Critical: Failed to rollback round ${roundId}: ${rollbackError.message}`
      );
    }
  }

  /**
   * ORIGINAL: Gets a round by ID
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
      logger.error("Failed to get round:", error);

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
   * ORIGINAL: Gets all active rounds
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
      });

      return rounds;
    } catch (error: any) {
      logger.error("Failed to get active rounds:", error);
      throw new RoundServiceError(
        `Failed to get active rounds: ${error.message}`,
        "ACTIVE_ROUNDS_FETCH_FAILED",
        500
      );
    }
  }

  /**
   * ORIGINAL: Locks a round (no more predictions allowed)
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

      logger.info(`Round locked: ${roundId}`);
    } catch (error: any) {
      logger.error("Failed to lock round:", error);

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
   * ORIGINAL: Checks if a round should be auto-locked based on time
   */
  async autoLockExpiredRounds(): Promise<void> {
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

      for (const round of expiredRounds) {
        await this.lockRound(round.id);
      }

      if (expiredRounds.length > 0) {
        logger.info(`Auto-locked ${expiredRounds.length} expired rounds`);
      }
    } catch (error) {
      logger.error("Failed to auto-lock expired rounds:", error);
    }
  }

  /**
   * ORIGINAL: Gets historical rounds with pagination and aggregate stats
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
          in: [RoundStatus.RESOLVED, RoundStatus.CANCELLED],
        },
      };

      // Apply optional filters
      if (options.mode) {
        where.mode = options.mode === "UP_DOWN" ? GameMode.UP_DOWN : GameMode.LEGENDS;
      }

      if (options.status) {
        where.status = options.status === "RESOLVED" ? RoundStatus.RESOLVED : RoundStatus.CANCELLED;
      }

      // Get total count for pagination
      const total = await prisma.round.count({ where });

      // Get rounds with predictions for aggregate stats
      const rounds = await prisma.round.findMany({
        where,
        orderBy: {
          createdAt: "desc", // FIXED: Use createdAt instead of resolvedAt (might not exist)
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
          0
        );
        const winnerCount = round.predictions.filter(
          (p: any) => p.won === true
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
    } catch (error: any) {
      logger.error("Failed to get rounds history:", error);
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

      // Refund all predictions in a transaction
      await prisma.$transaction(async (tx) => {
        // Update round status
        await tx.round.update({
          where: { id: roundId },
          data: { status: RoundStatus.CANCELLED },
        });

        // Refund each user
        for (const prediction of round.predictions) {
          await tx.user.update({
            where: { id: prediction.userId },
            data: {
              virtualBalance: {
                increment: prediction.amount,
              },
            },
          });

          // Create refund transaction
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
      logger.error("Failed to cancel round:", error);

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