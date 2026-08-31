import cron, { ScheduledTask } from "node-cron";
import priceOracle from "./oracle";
import resolutionService from "./resolution.service";
import logger from "../utils/logger";
import {
  isLockLostError,
  withDistributedLock,
  type LockHandle,
} from "../utils/distributed-lock";
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

  /**
   * Resolve every eligible round as the single leader across all instances.
   *
   * This is the longest-running critical job: it loops N rounds, each with up
   * to MAX_RESOLVE_RETRIES attempts and 5 s/10 s backoff sleeps, so a busy tick
   * can far outlast any fixed TTL. The heartbeat keeps the 60 s lock alive for
   * the whole run; `maxHoldSeconds` still caps a hung run so a stuck instance
   * cannot hold leadership indefinitely.
   */
  async resolveEligibleRounds(): Promise<void> {
    await withDistributedLock(
      "oracle-resolve-rounds",
      (lock) => this.resolveEligibleRoundsInternal(lock),
      { ttlSeconds: 60, maxHoldSeconds: 600 },
    );
  }

  private async resolveEligibleRoundsInternal(lock: LockHandle): Promise<void> {
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
        // Fail closed between rounds: the batch may have outlived our
        // leadership, and the new leader is resolving these same rounds.
        lock.assertHeld();
        await this.resolveWithRetry(round.id, currentPrice.toString(), lock);
      }
    } catch (error) {
      if (isLockLostError(error)) {
        oracleResolveBlockedTotal.inc({ reason: "lock_lost" });
        logger.warn(
          "[OracleService] Aborted resolve loop: distributed lock lost",
          { reason: error.reason },
        );
        return;
      }
      logger.error("[OracleService] Error in resolve loop:", error);
    }
  }

  /**
   * Resolve one round with bounded retries.
   *
   * Leadership is re-checked before every attempt, including after each
   * backoff sleep — those sleeps are where a lock is most likely to be lost.
   * A {@link LockLostError} propagates to the caller and ends the whole batch.
   */
  private async resolveWithRetry(
    roundId: string,
    price: string,
    lock: LockHandle,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RESOLVE_RETRIES; attempt++) {
      lock.assertHeld();

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
        if (isLockLostError(error)) {
          throw error;
        }

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
