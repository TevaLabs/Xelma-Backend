import cron from "node-cron";
import roundService from "./round.service";
import priceOracle from "./oracle";
import logger from "../utils/logger";
import { prisma } from "../lib/prisma";

class RoundSchedulerService {
  start(): void {
    if (process.env.ROUND_SCHEDULER_ENABLED !== "true") {
      logger.info("[Round Scheduler] Disabled (ROUND_SCHEDULER_ENABLED is not 'true')");
      return;
    }

    logger.info("[Round Scheduler] Starting round creation and close jobs");

    // Create new round every 4 minutes (1 min round + 3 min processing)
    cron.schedule("0 */4 * * * *", async () => {
      await this.createRound();
    });

    // Close (lock) eligible rounds every 30 seconds
    cron.schedule("*/30 * * * * *", async () => {
      await this.closeEligibleRounds();
    });
  }

  private async createRound(): Promise<void> {
    try {
      const startPrice = priceOracle.getPrice();

      if (!startPrice || startPrice <= 0) {
        logger.warn("[Round Scheduler] Skipping round creation: invalid price from oracle");
        return;
      }

      const mode = this.getMode();

      const round = await roundService.startRound(mode, startPrice, 1);

      logger.info(
        `[Round Scheduler] Created round ${round.id}, mode=${mode}, startPrice=${startPrice.toFixed(4)}`,
      );
    } catch (error) {
      logger.error("[Round Scheduler] Failed to create round:", error);
    }
  }

  private async closeEligibleRounds(): Promise<void> {
    try {
      const now = new Date();

      const expiredCount = await prisma.round.count({
        where: {
          status: "ACTIVE",
          endTime: { lte: now },
        },
      });

      if (expiredCount === 0) {
        return;
      }

      await roundService.autoLockExpiredRounds();

      logger.info(`[Round Scheduler] Locked ${expiredCount} expired rounds`);
    } catch (error) {
      logger.error("[Round Scheduler] Failed to close rounds:", error);
    }
  }

  private getMode(): "UP_DOWN" | "LEGENDS" {
    const mode = process.env.ROUND_SCHEDULER_MODE || "UP_DOWN";
    if (mode === "LEGENDS") {
      return "LEGENDS";
    }
    return "UP_DOWN";
  }
}

export default new RoundSchedulerService();
