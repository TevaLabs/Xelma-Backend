import cron, { ScheduledTask } from "node-cron";
import resolutionService from "./resolution.service";
import notificationService from "./notification.service";
import priceOracle from "./oracle";
import logger from "../utils/logger";
import { prisma } from "../lib/prisma";
import { RoundLifecycleOutcome } from "../types/round.types";

class SchedulerService {
  private cronTasks: ScheduledTask[] = [];

  /**
   * Notification retention window in days, controlled by NOTIFICATION_RETENTION_DAYS env var.
   * Defaults to 30 days if unset or invalid.
   */
  static getRetentionDays(): number {
    const raw = process.env.NOTIFICATION_RETENTION_DAYS;
    if (!raw) return 30;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  /**
   * Cleanup cron expression, controlled by NOTIFICATION_CLEANUP_CRON env var.
   * Defaults to daily at 2:00 AM ("0 2 * * *").
   */
  static getCleanupCronExpression(): string {
    return process.env.NOTIFICATION_CLEANUP_CRON || "0 2 * * *";
  }

  /**
   * Start the scheduler
   */
  start(): void {
    const cleanupCron = SchedulerService.getCleanupCronExpression();
    logger.info(`Starting notification cleanup scheduler (cron: "${cleanupCron}", retention: ${SchedulerService.getRetentionDays()} days)`);
    this.cronTasks.push(
      cron.schedule(cleanupCron, async () => {
        await this.cleanupOldNotifications();
      }),
    );

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

    this.cronTasks.push(
      cron.schedule(cronExpression, async () => {
        await this.autoResolveRounds();
      }),
    );
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    for (const task of this.cronTasks) {
      task.stop();
    }
    this.cronTasks = [];
    logger.info("Scheduler service stopped");
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

      if (!currentPrice || currentPrice.lte(0)) {
        logger.warn("Cannot auto-resolve rounds: Invalid price from oracle");
        return;
      }

      if (priceOracle.isStale()) {
        logger.warn("Cannot auto-resolve rounds: Oracle price data is stale");
        return;
      }

      // Resolve each round
      for (const round of expiredRounds) {
        try {
          const result = await resolutionService.resolveRound(
            round.id,
            currentPrice.toString(),
          );

          if (!result) {
            logger.warn(`Auto-resolution skipped for round ${round.id}: empty result`);
            continue;
          }

          if (result.outcome === RoundLifecycleOutcome.UPDATED) {
            logger.info(
              `Auto-resolved round ${round.id} with price ${currentPrice.toString()}`,
            );
          } else if (result.outcome === RoundLifecycleOutcome.ALREADY_RESOLVED) {
            logger.info(`Round ${round.id} was already resolved`);
          }
        } catch (error) {
          logger.error(`Failed to auto-resolve round ${round.id}:`, error);
        }
      }
    } catch (error) {
      logger.error("Error in auto-resolution scheduler:", error);
    }
  }

  /**
   * Cleanup old notifications older than NOTIFICATION_RETENTION_DAYS (default 30).
   * @visibleForTesting
   */
  async cleanupOldNotifications(): Promise<void> {
    const retentionDays = SchedulerService.getRetentionDays();
    logger.info(`Notification cleanup started (retention: ${retentionDays} days)`);
    try {
      const deletedCount =
        await notificationService.cleanupOldNotifications(retentionDays);
      logger.info(
        `Notification cleanup completed: deleted ${deletedCount} notification(s) older than ${retentionDays} day(s)`,
      );
    } catch (error) {
      logger.error("Error in notification cleanup scheduler:", error);
    }
  }
}

export default new SchedulerService();
