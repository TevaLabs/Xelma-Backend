import cron, { ScheduledTask } from "node-cron";
import priceOracle from "./oracle";
import resolutionService from "./resolution.service";
import logger from "../utils/logger";
import { withDistributedLock } from "../utils/distributed-lock";
import { prisma } from "../lib/prisma";
import { RoundLifecycleOutcome } from "../types/round.types";
import { oracleResolveBlockedTotal } from "../metrics/application.metrics";

const MAX_RESOLVE_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OracleService {
  private cronTask: ScheduledTask | null = null;
  private _running = false;

  start(): void {
    if (this._running) {
      logger.warn("[OracleService] Already running — ignoring duplicate start");
      return;
    }

    const intervalSeconds = parseInt(
      process.env.ORACLE_RESOLVE_INTERVAL_SECONDS || "30",
      10,
    );

    const cronExpression = `*/${intervalSeconds} * * * * *`;
    logger.info(
      `[OracleService] Starting oracle resolve loop (interval: ${intervalSeconds}s)`,
    );

    this.cronTask = cron.schedule(cronExpression, async () => {
      await this.resolveEligibleRounds();
    });

    this._running = true;
  }

  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    this._running = false;
    logger.info("[OracleService] Stopped");
  }

  isRunning(): boolean {
    return this._running;
  }

  async resolveEligibleRounds(): Promise<void> {
    await withDistributedLock(
      "oracle-resolve-rounds",
      () => this.resolveEligibleRoundsInternal(),
      { ttlSeconds: 60 },
    );
  }

  private async resolveEligibleRoundsInternal(): Promise<void> {
    try {
      const currentPrice = priceOracle.getPrice();

      if (!currentPrice || currentPrice.lte(0)) {
        oracleResolveBlockedTotal.inc({ reason: "invalid_price" });
        logger.warn(
          "[OracleService] Skipping resolve: invalid price from oracle",
        );
        return;
      }

      if (priceOracle.isStale()) {
        oracleResolveBlockedTotal.inc({ reason: "stale_price" });
        logger.warn(
          "[OracleService] Skipping resolve: oracle price data is stale",
          {
            lastUpdatedAt: priceOracle.getLastUpdatedAt()?.toISOString() ?? null,
            stalenessSeconds: priceOracle.getStalenessSeconds(),
          },
        );
        return;
      }

      const bufferTime = new Date(Date.now() - 15_000);

      const eligibleRounds = await prisma.round.findMany({
        where: {
          status: { in: ["ACTIVE", "LOCKED"] },
          endTime: { lte: bufferTime },
        },
        orderBy: { endTime: "asc" },
      });

      if (eligibleRounds.length === 0) {
        return;
      }

      logger.info(
        `[OracleService] Found ${eligibleRounds.length} round(s) eligible for resolution`,
      );

      for (const round of eligibleRounds) {
        await this.resolveWithRetry(round.id, currentPrice.toString());
      }
    } catch (error) {
      logger.error("[OracleService] Error in resolve loop:", error);
    }
  }

  private async resolveWithRetry(
    roundId: string,
    price: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RESOLVE_RETRIES; attempt++) {
      try {
        const result = await resolutionService.resolveRound(roundId, price);

        if (!result) {
          logger.warn(
            `[OracleService] Round ${roundId}: empty result on attempt ${attempt}`,
          );
          return;
        }

        if (result.outcome === RoundLifecycleOutcome.UPDATED) {
          logger.info(
            `[OracleService] Round ${roundId} resolved successfully (price=${price}, attempt=${attempt})`,
          );
          return;
        }

        if (result.outcome === RoundLifecycleOutcome.ALREADY_RESOLVED) {
          logger.info(
            `[OracleService] Round ${roundId} was already resolved`,
          );
          return;
        }

        if (result.outcome === RoundLifecycleOutcome.NO_OP) {
          logger.info(
            `[OracleService] Round ${roundId}: no-op (status not eligible)`,
          );
          return;
        }

        return;
      } catch (error) {
        logger.error(
          `[OracleService] Failed to resolve round ${roundId} (attempt ${attempt}/${MAX_RESOLVE_RETRIES}):`,
          error,
        );

        if (attempt < MAX_RESOLVE_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    logger.error(
      `[OracleService] Round ${roundId}: exhausted all ${MAX_RESOLVE_RETRIES} retry attempts`,
    );
  }
}

export default new OracleService();
