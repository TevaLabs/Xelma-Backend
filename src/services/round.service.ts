import { GameMode } from "@prisma/client";
import sorobanService from "./soroban.service";
import websocketService from "./websocket.service";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import { prisma } from "../lib/prisma";
import { ConflictError } from "../utils/errors";

export class RoundService {
  /**
   * Starts a new prediction round
   */
  async startRound(
    mode: "UP_DOWN" | "LEGENDS",
    startPrice: number,
    durationMinutes: number,
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
          "ACTIVE_ROUND_EXISTS",
        );
      }

      const startTime = new Date();
      const endTime = new Date(
        startTime.getTime() + durationMinutes * 60 * 1000,
      );

      let sorobanRoundId: string | null = null;

      // Mode 0 (UP_DOWN): Create round on Soroban contract
      if (mode === "UP_DOWN") {
        // Convert duration to ledgers (~5 seconds per ledger)
        const durationLedgers = Math.floor((durationMinutes * 60) / 5);
        try {
          await sorobanService.createRound(
            startPrice,
            0,
          );
        } catch (err) {
          logger.warn(
            "Soroban round creation bypassed (Disabled or failed). Proceeding with DB-only round.",
            err,
          );
        }
      }

      // Mode 1 (LEGENDS): Define price ranges
      let priceRanges: any = null;
      if (mode === "LEGENDS") {
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

      // Create round in database
      const round = await prisma.round.create({
        data: {
          mode: gameMode,
          status: "ACTIVE",
          startTime,
          endTime,
          startPrice,
          sorobanRoundId,
          priceRanges: priceRanges
            ? JSON.parse(JSON.stringify(priceRanges))
            : null,
        },
      });

      logger.info(
        `Round created: ${round.id}, mode=${mode}, sorobanId=${sorobanRoundId}`,
      );

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
    } catch (error) {
      logger.error("Failed to start round:", error);
      throw error;
    }
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
   * Gets all active rounds
   */
  async getActiveRounds(): Promise<any[]> {
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
   * Locks a round (no more predictions allowed)
   */
  async lockRound(roundId: string): Promise<{
    status: "updated" | "already_locked" | "already_resolved" | "error";
    error?: string;
  }> {
    try {
      const round = await prisma.round.findUnique({
        where: { id: roundId },
        select: { status: true },
      });

      if (!round) {
        return { status: "error", error: "Round not found" };
      }

      if (round.status === "LOCKED") {
        return { status: "already_locked" };
      }

      if (round.status === "RESOLVED") {
        return { status: "already_resolved" };
      }

      await prisma.round.update({
        where: { id: roundId },
        data: { status: "LOCKED" },
      });

      logger.info(`Round locked: ${roundId}`);
      return { status: "updated" };
    } catch (error) {
      logger.error("Failed to lock round:", error);
      return {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Checks if a round should be auto-locked based on time
   */
  async autoLockExpiredRounds(): Promise<{
    processed: number;
    locked: number;
    skipped: number;
    errors: number;
  }> {
    const stats = { processed: 0, locked: 0, skipped: 0, errors: 0 };
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

      for (const round of expiredRounds) {
        stats.processed++;
        const result = await this.lockRound(round.id);

        if (result.status === "updated") stats.locked++;
        else if (
          result.status === "already_locked" ||
          result.status === "already_resolved"
        )
          stats.skipped++;
        else stats.errors++;
      }

      if (stats.processed > 0) {
        logger.info(
          `Auto-lock results: ${stats.locked} locked, ${stats.skipped} skipped, ${stats.errors} errors (out of ${stats.processed} expired)`,
        );
      }
      return stats;
    } catch (error) {
      logger.error("Failed to auto-lock expired rounds:", error);
      return stats;
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
}

export default new RoundService();
