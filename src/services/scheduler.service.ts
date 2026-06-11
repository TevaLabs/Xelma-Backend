import cron, { ScheduledTask } from 'node-cron';
import resolutionService from './resolution.service';
import notificationService from './notification.service';
import retentionService from './retention.service';
import priceOracle from './oracle';
import logger from '../utils/logger';
import { withDistributedLock } from '../utils/distributed-lock';
import { prisma } from '../lib/prisma';
import { RoundLifecycleOutcome } from '../types/round.types';
import {
   schedulerItemsProcessedTotal,
   schedulerRunsTotal,
} from '../metrics/application.metrics';

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
      return process.env.NOTIFICATION_CLEANUP_CRON || '0 2 * * *';
   }

   /**
    * Start the scheduler
    */
   start(): void {
      const cleanupCron = SchedulerService.getCleanupCronExpression();
      logger.info(
         `Starting notification cleanup scheduler (cron: "${cleanupCron}", retention: ${SchedulerService.getRetentionDays()} days)`
      );
      this.cronTasks.push(
         cron.schedule(cleanupCron, async () => {
            await this.cleanupOldNotifications();
         })
      );

      // Schedule retention policy execution: Run daily at 3 AM (always active)
      logger.info('Starting retention policy scheduler (daily at 3:00 AM)');
      this.cronTasks.push(
         cron.schedule('0 3 * * *', async () => {
            await this.runRetentionPolicies();
         })
      );

      // Outbox poller — runs every OUTBOX_POLL_INTERVAL_SECONDS (default 10s).
      // Dispatches PENDING outbox events written atomically with business
      // transactions (Issue #18). Runs regardless of API_ONLY mode because
      // the outbox must drain even in split-deployment setups.
      const outboxIntervalSeconds = getOutboxPollIntervalSeconds();
      const outboxCron = `*/${outboxIntervalSeconds} * * * * *`;
      logger.info(`Starting outbox poller (interval: ${outboxIntervalSeconds}s)`);
      this.cronTasks.push(
         cron.schedule(outboxCron, async () => {
            await this.pollOutbox();
         })
      );

      // Outbox cleanup — runs daily at 3:30 AM alongside retention jobs.
      logger.info('Starting outbox cleanup scheduler (daily at 3:30 AM)');
      this.cronTasks.push(
         cron.schedule('30 3 * * *', async () => {
            await this.cleanupOutbox();
         })
      );

      if (process.env.AUTO_RESOLVE_ENABLED !== 'true') {
         logger.info('Auto-resolution scheduler is disabled');
         return;
      }

      const intervalSeconds = parseInt(
         process.env.AUTO_RESOLVE_INTERVAL_SECONDS || '30',
         10
      );

      // Create cron expression for interval (e.g., every 30 seconds)
      // Note: node-cron supports seconds as the first field
      const cronExpression = `*/${intervalSeconds} * * * * *`;

      logger.info(
         `Starting auto-resolution scheduler (interval: ${intervalSeconds}s)`
      );

      this.cronTasks.push(
         cron.schedule(cronExpression, async () => {
            await this.autoResolveRounds();
         })
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
      logger.info('Scheduler service stopped');
   }

   /**
    * Check for and resolve expired rounds
    * Protected by distributed lock to prevent duplicate resolution across instances
    */
   async autoResolveRounds(): Promise<void> {
      // Use distributed lock to ensure only one instance runs this at a time
      await withDistributedLock(
         'auto-resolve-rounds',
         () => this.autoResolveRoundsInternal(),
         { ttlSeconds: 30 }
      );
   }

   /**
    * Internal implementation of auto-resolve
    * Wrapped by autoResolveRounds with distributed lock
    */
   private async autoResolveRoundsInternal(): Promise<void> {
      try {
         const now = new Date();

         // Find rounds that have ended but are still active or locked (not resolved)
         // Only resolve rounds that ended at least 15 seconds ago to ensure price stability
         const bufferTime = new Date(now.getTime() - 15000);

         const expiredRounds = await prisma.round.findMany({
            where: {
               status: {
                  in: ['ACTIVE', 'LOCKED'],
               },
               endTime: {
                  lte: bufferTime,
               },
            },
         });

         if (expiredRounds.length === 0) {
            schedulerRunsTotal.inc({
               job: 'auto_resolve_rounds',
               outcome: 'no_op',
            });
            return;
         }

         logger.info(`Found ${expiredRounds.length} expired rounds to resolve`);

         // Get current price
         const currentPrice = priceOracle.getPrice();

         if (!currentPrice || currentPrice.lte(0)) {
            logger.warn(
               'Cannot auto-resolve rounds: Invalid price from oracle'
            );
            schedulerRunsTotal.inc({
               job: 'auto_resolve_rounds',
               outcome: 'skipped',
            });
            return;
         }

         if (priceOracle.isStale()) {
            logger.warn(
               'Cannot auto-resolve rounds: Oracle price data is stale'
            );
            schedulerRunsTotal.inc({
               job: 'auto_resolve_rounds',
               outcome: 'skipped',
            });
            return;
         }

         // Resolve each round
         for (const round of expiredRounds) {
            try {
               const result = await resolutionService.resolveRound(
                  round.id,
                  currentPrice.toString()
               );

               if (!result) {
                  logger.warn(
                     `Auto-resolution skipped for round ${round.id}: empty result`
                  );
                  schedulerItemsProcessedTotal.inc({
                     job: 'auto_resolve_rounds',
                     outcome: 'skipped',
                  });
                  continue;
               }

               if (result.outcome === RoundLifecycleOutcome.UPDATED) {
                  logger.info(
                     `Auto-resolved round ${round.id} with price ${currentPrice.toString()}`
                  );
                  schedulerItemsProcessedTotal.inc({
                     job: 'auto_resolve_rounds',
                     outcome: 'success',
                  });
               } else if (
                  result.outcome === RoundLifecycleOutcome.ALREADY_RESOLVED
               ) {
                  logger.info(`Round ${round.id} was already resolved`);
                  schedulerItemsProcessedTotal.inc({
                     job: 'auto_resolve_rounds',
                     outcome: 'no_op',
                  });
               }
            } catch (error) {
               logger.error(`Failed to auto-resolve round ${round.id}:`, error);
               schedulerItemsProcessedTotal.inc({
                  job: 'auto_resolve_rounds',
                  outcome: 'failure',
               });
            }
         }
         schedulerRunsTotal.inc({
            job: 'auto_resolve_rounds',
            outcome: 'success',
         });
      } catch (error) {
         logger.error('Error in auto-resolution scheduler:', error);
         schedulerRunsTotal.inc({
            job: 'auto_resolve_rounds',
            outcome: 'failure',
         });
      }
   }

   /**
    * Cleanup old notifications older than NOTIFICATION_RETENTION_DAYS (default 30).
    * Protected by distributed lock to prevent duplicate cleanup across instances
    * @visibleForTesting
    */
   async cleanupOldNotifications(): Promise<void> {
      await withDistributedLock(
         'cleanup-old-notifications',
         () => this.cleanupOldNotificationsInternal(),
         { ttlSeconds: 60 }
      );
   }

   /**
    * Internal implementation of notification cleanup
    * Wrapped by cleanupOldNotifications with distributed lock
    */
   private async cleanupOldNotificationsInternal(): Promise<void> {
      const retentionDays = SchedulerService.getRetentionDays();
      logger.info(
         `Notification cleanup started (retention: ${retentionDays} days)`
      );
      try {
         const deletedCount =
            await notificationService.cleanupOldNotifications(retentionDays);
         logger.info(
            `Notification cleanup completed: deleted ${deletedCount} notification(s) older than ${retentionDays} day(s)`
         );
         schedulerItemsProcessedTotal.inc(
            { job: 'notification_cleanup', outcome: 'success' },
            deletedCount
         );
         schedulerRunsTotal.inc({
            job: 'notification_cleanup',
            outcome: 'success',
         });
      } catch (error) {
         logger.error('Error in notification cleanup scheduler:', error);
         schedulerRunsTotal.inc({
            job: 'notification_cleanup',
            outcome: 'failure',
         });
      }
   }

   /**
    * Run retention policies for challenges and chat messages
    * Protected by distributed lock to prevent duplicate cleanup across instances
    * @visibleForTesting
    */
   async runRetentionPolicies(): Promise<void> {
      await withDistributedLock(
         'run-retention-policies',
         () => this.runRetentionPoliciesInternal(),
         { ttlSeconds: 120 }
      );
   }

   /**
    * Internal implementation of retention policies
    * Wrapped by runRetentionPolicies with distributed lock
    */
   private async runRetentionPoliciesInternal(): Promise<void> {
      try {
         logger.info('Starting scheduled retention policy execution');
         const results = await retentionService.runAllPolicies();

         // Log summary
         const summary = results
            .map(r => `${r.entity}: ${r.deletedCount} records deleted`)
            .join(', ');

         logger.info(`Retention policy execution completed: ${summary}`);
         for (const result of results) {
            schedulerItemsProcessedTotal.inc(
               { job: 'retention_policies', outcome: 'success' },
               result.deletedCount
            );
         }
         schedulerRunsTotal.inc({
            job: 'retention_policies',
            outcome: 'success',
         });
      } catch (error) {
         logger.error('Error in retention policy scheduler:', error);
         schedulerRunsTotal.inc({
            job: 'retention_policies',
            outcome: 'failure',
         });
      }
   }

   /**
    * Build the dispatch handlers used by the outbox poller.
    * Kept here (not in outbox.service) to avoid a circular import:
    * outbox.service → notification.service → (no cycle)
    * outbox.service → websocket.service → (no cycle)
    * scheduler.service already imports both, so wiring happens here.
    */
   private buildOutboxHandlers(): OutboxDispatchHandlers {
      return {
         notificationCreate: async (payload) => {
            return notificationService.createNotificationForRetry(payload);
         },
         websocketEmit: ({ eventName, room, data }) => {
            websocketService.replayEmit(eventName, { room, data });
         },
      };
   }

   /**
    * Poll the outbox for PENDING events and dispatch them.
    * Protected by a distributed lock so only one instance runs per interval.
    * @visibleForTesting
    */
   async pollOutbox(): Promise<void> {
      await withDistributedLock(
         'outbox-poll',
         () => this.pollOutboxInternal(),
         { ttlSeconds: getOutboxPollIntervalSeconds() + 5 }
      );
   }

   private async pollOutboxInternal(): Promise<void> {
      try {
         const result = await outboxService.processOutbox(this.buildOutboxHandlers());
         if (result.processed > 0 || result.failed > 0) {
            logger.info('Outbox poll completed', result);
         }
      } catch (error) {
         logger.error('Error in outbox poller:', error);
      }
   }

   /**
    * Delete old PROCESSED outbox rows.
    * @visibleForTesting
    */
   async cleanupOutbox(): Promise<void> {
      await withDistributedLock(
         'outbox-cleanup',
         () => this.cleanupOutboxInternal(),
         { ttlSeconds: 60 }
      );
   }

   private async cleanupOutboxInternal(): Promise<void> {
      try {
         const count = await outboxService.cleanupProcessed();
         if (count > 0) {
            logger.info(`Outbox cleanup: removed ${count} processed event(s)`);
         }
      } catch (error) {
         logger.error('Error in outbox cleanup scheduler:', error);
      }
   }
}

export default new SchedulerService();
