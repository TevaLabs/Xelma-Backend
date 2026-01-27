import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import resolutionService from "./resolution.service";
import notificationService from "./notification.service";
import priceOracle from "./oracle";
import logger from "../utils/logger";

const prisma = new PrismaClient();

class SchedulerService {
  /**
   * Start the scheduler
   */
  start(): void {
    if (process.env.AUTO_RESOLVE_ENABLED !== "true") {
      logger.info("Auto-resolution scheduler is disabled");
      return;
    }

    const intervalSeconds = parseInt(
      process.env.AUTO_RESOLVE_INTERVAL_SECONDS || "30",
      10,
    );

    // Create cron expression for interval (e.g., every 30 seconds)
    // Note: node-cron supports seconds as the first field
    const cronExpression = `*/${intervalSeconds} * * * * *`;

    logger.info(
      `Starting auto-resolution scheduler (interval: ${intervalSeconds}s)`,
    );

    cron.schedule(cronExpression, async () => {
      await this.autoResolveRounds();
    });

    // Schedule notification cleanup: Run daily at 2 AM
    logger.info("Starting notification cleanup scheduler (daily at 2:00 AM)");
    cron.schedule("0 2 * * *", async () => {
      await this.cleanupOldNotifications();
    });
  }

  /**
   * Check for and resolve expired rounds
   */
  async autoResolveRounds(): Promise<void> {
    try {
      const now = new Date();

      // Find rounds that have ended but are still active or locked (not resolved)
      // Only resolve rounds that ended at least 15 seconds ago to ensure price stability
      const bufferTime = new Date(now.getTime() - 15000);

      const expiredRounds = await prisma.round.findMany({
        where: {
          status: {
            in: ["ACTIVE", "LOCKED"],
          },
          endTime: {
            lte: bufferTime,
          },
        },
      });

      if (expiredRounds.length === 0) {
        return;
      }

      logger.info(`Found ${expiredRounds.length} expired rounds to resolve`);

      // Get current price
      const currentPrice = priceOracle.getPrice();

      if (!currentPrice || currentPrice <= 0) {
        logger.warn("Cannot auto-resolve rounds: Invalid price from oracle");
        return;
      }

      // Resolve each round
      for (const round of expiredRounds) {
        try {
          await resolutionService.resolveRound(round.id, currentPrice);
          logger.info(
            `Auto-resolved round ${round.id} with price ${currentPrice}`,
          );
        } catch (error) {
          logger.error(`Failed to auto-resolve round ${round.id}:`, error);
        }
      }
    } catch (error) {
      logger.error("Error in auto-resolution scheduler:", error);
    }
  }

  /**
   * Cleanup old notifications (older than 30 days)
   */
  private async cleanupOldNotifications(): Promise<void> {
    try {
      const deletedCount =
        await notificationService.cleanupOldNotifications(30);
      logger.info(
        `Notification cleanup completed: Deleted ${deletedCount} notifications`,
      );
    } catch (error) {
      logger.error("Error in notification cleanup scheduler:", error);
    }
  }
}

export default new SchedulerService();
