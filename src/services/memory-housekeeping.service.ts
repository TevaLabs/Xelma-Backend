import config from '../config';
import logger from '../utils/logger';
import retentionService from './retention.service';
import { cleanupExpiredIdempotencyKeys } from '../utils/idempotency.util';

export interface MemoryHousekeepingOptions {
  /** Interval in milliseconds between sweeps. Default: 60,000 (1 minute). */
  intervalMs?: number;
}

export class MemoryHousekeepingService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Starts the periodic housekeeping loop. Safe to call multiple times (no-op
   * if already running). The timer is unref'd so it will not prevent node
   * from exiting.
   */
  start(options: MemoryHousekeepingOptions = {}): void {
    if (this.timer) {
      return;
    }

    if (config.app.dataStore !== 'memory') {
      logger.debug('[memory-housekeeping] Skipping: dataStore is not memory');
      return;
    }

    const intervalMs = options.intervalMs ?? 60_000;
    logger.info('[memory-housekeeping] Starting memory housekeeping loop', { intervalMs });

    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);

    // Don't keep the process alive solely for in-memory housekeeping
    this.timer.unref();
  }

  /**
   * Stops the periodic housekeeping loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[memory-housekeeping] Stopped memory housekeeping loop');
    }
  }

  /**
   * Executes a single sweep of all memory housekeeping tasks:
   * 1. Expired auth challenges
   * 2. Expired in-memory idempotency keys
   *
   * Guards against overlapping executions.
   */
  async runOnce(): Promise<{ challengesPurged: number; idempotencyKeysPurged: number }> {
    if (this.isRunning) {
      logger.debug('[memory-housekeeping] Previous sweep still in progress, skipping');
      return { challengesPurged: 0, idempotencyKeysPurged: 0 };
    }

    this.isRunning = true;
    try {
      // 1. Prune expired auth challenges from memory-prisma
      const challengeResult = await retentionService.cleanupAuthChallenges();

      // 2. Prune expired idempotency keys from the in-memory Map
      const idempotencyKeysPurged = await cleanupExpiredIdempotencyKeys();

      const challengesPurged = challengeResult.deletedCount;

      if (challengesPurged > 0 || idempotencyKeysPurged > 0) {
        logger.info('[memory-housekeeping] Sweep completed', {
          challengesPurged,
          idempotencyKeysPurged,
        });
      }

      return { challengesPurged, idempotencyKeysPurged };
    } catch (error) {
      logger.error('[memory-housekeeping] Error during sweep', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { challengesPurged: 0, idempotencyKeysPurged: 0 };
    } finally {
      this.isRunning = false;
    }
  }
}

export default new MemoryHousekeepingService();
