import cron, { ScheduledTask } from 'node-cron';
import roundService from './round.service';
import priceOracle from './oracle';
import logger from '../utils/logger';
import { withDistributedLock } from '../utils/distributed-lock';
import { prisma } from '../lib/prisma';
import { toNumber } from '../utils/decimal.util';
import {
   schedulerItemsProcessedTotal,
   schedulerRunsTotal,
} from '../metrics/application.metrics';

class RoundSchedulerService {
   private cronTasks: ScheduledTask[] = [];

   start(): void {
      if (process.env.ROUND_SCHEDULER_ENABLED !== 'true') {
         logger.info(
            "[Round Scheduler] Disabled (ROUND_SCHEDULER_ENABLED is not 'true')"
         );
         return;
      }

      logger.info('[Round Scheduler] Starting round creation and close jobs');

      // Create new round every 4 minutes (1 min round + 3 min processing)
      this.cronTasks.push(
         cron.schedule('0 */4 * * * *', async () => {
            await this.createRound();
         })
      );

      // Close (lock) eligible rounds every 30 seconds
      this.cronTasks.push(
         cron.schedule('*/30 * * * * *', async () => {
            await this.closeEligibleRounds();
         })
      );
   }

   stop(): void {
      for (const task of this.cronTasks) {
         task.stop();
      }
      this.cronTasks = [];
      logger.info('[Round Scheduler] Stopped');
   }

   /** @visibleForTesting */
   async createRound(): Promise<void> {
      await withDistributedLock(
         'create-round',
         () => this.createRoundInternal(),
         { ttlSeconds: 30 }
      );
   }

   private async createRoundInternal(): Promise<void> {
      try {
         const startPrice = priceOracle.getPrice();

         if (!startPrice || startPrice.lte(0)) {
            logger.warn(
               '[Round Scheduler] Skipping round creation: invalid price from oracle'
            );
            schedulerRunsTotal.inc({
               job: 'round_create',
               outcome: 'skipped',
            });
            return;
         }

         if (priceOracle.isStale()) {
            logger.warn(
               '[Round Scheduler] Skipping round creation: oracle price data is stale'
            );
            schedulerRunsTotal.inc({
               job: 'round_create',
               outcome: 'skipped',
            });
            return;
         }

         const mode = this.getMode();
         const gameMode = mode === 'UP_DOWN' ? 'UP_DOWN' : 'LEGENDS';

         // Check if there's already an active round for this mode
         const existingActiveRound = await prisma.round.findFirst({
            where: {
               mode: gameMode,
               status: 'ACTIVE',
            },
         });

         if (existingActiveRound) {
            logger.info(
               `[Round Scheduler] Skipping round creation: active ${mode} round already exists (${existingActiveRound.id})`
            );
            schedulerRunsTotal.inc({
               job: 'round_create',
               outcome: 'no_op',
            });
            return;
         }

         const round = await roundService.startRound(
            mode,
            toNumber(startPrice),
            1
         );

         logger.info(
            `[Round Scheduler] Created round ${round.id}, mode=${mode}, startPrice=${startPrice.toFixed(4)}`
         );
         schedulerItemsProcessedTotal.inc({
            job: 'round_create',
            outcome: 'success',
         });
         schedulerRunsTotal.inc({
            job: 'round_create',
            outcome: 'success',
         });
      } catch (error: any) {
         if (error.code === 'ACTIVE_ROUND_EXISTS') {
            logger.info(`[Round Scheduler] ${error.message}`);
            schedulerRunsTotal.inc({
               job: 'round_create',
               outcome: 'no_op',
            });
         } else {
            logger.error('[Round Scheduler] Failed to create round:', error);
            schedulerRunsTotal.inc({
               job: 'round_create',
               outcome: 'failure',
            });
         }
      }
   }

   /** @visibleForTesting */
   async closeEligibleRounds(): Promise<void> {
      await withDistributedLock(
         'close-eligible-rounds',
         () => this.closeEligibleRoundsInternal(),
         { ttlSeconds: 30 }
      );
   }

   private async closeEligibleRoundsInternal(): Promise<void> {
      try {
         const now = new Date();

         const expiredCount = await prisma.round.count({
            where: {
               status: 'ACTIVE',
               endTime: { lte: now },
            },
         });

         if (expiredCount === 0) {
            schedulerRunsTotal.inc({
               job: 'round_close',
               outcome: 'no_op',
            });
            return;
         }

         await roundService.autoLockExpiredRounds();

         logger.info(`[Round Scheduler] Locked ${expiredCount} expired rounds`);
         schedulerItemsProcessedTotal.inc(
            { job: 'round_close', outcome: 'success' },
            expiredCount
         );
         schedulerRunsTotal.inc({
            job: 'round_close',
            outcome: 'success',
         });
      } catch (error) {
         logger.error('[Round Scheduler] Failed to close rounds:', error);
         schedulerRunsTotal.inc({
            job: 'round_close',
            outcome: 'failure',
         });
      }
   }

   /** @visibleForTesting */
   getMode(): 'UP_DOWN' | 'LEGENDS' {
      const mode = process.env.ROUND_SCHEDULER_MODE || 'UP_DOWN';
      if (mode === 'LEGENDS') {
         return 'LEGENDS';
      }
      return 'UP_DOWN';
   }
}

export default new RoundSchedulerService();
