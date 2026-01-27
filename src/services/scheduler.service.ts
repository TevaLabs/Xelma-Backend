import cron from 'node-cron';
import { PrismaClient, RoundStatus } from '@prisma/client';
import resolutionService from './resolution.service';
import priceOracle from './oracle';
import logger from '../utils/logger';

const prisma = new PrismaClient();

class SchedulerService {
    /**
     * Start the scheduler
     */
    start(): void {
        if (process.env.AUTO_RESOLVE_ENABLED !== 'true') {
            logger.info('Auto-resolution scheduler is disabled');
            return;
        }

        const intervalSeconds = parseInt(process.env.AUTO_RESOLVE_INTERVAL_SECONDS || '30', 10);

        // Create cron expression for interval (e.g., every 30 seconds)
        // Note: node-cron supports seconds as the first field
        const cronExpression = `*/${intervalSeconds} * * * * *`;

        logger.info(`Starting auto-resolution scheduler (interval: ${intervalSeconds}s)`);

        cron.schedule(cronExpression, async () => {
            await this.autoResolveRounds();
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
                        in: [RoundStatus.ACTIVE, RoundStatus.LOCKED],
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
                logger.warn('Cannot auto-resolve rounds: Invalid price from oracle');
                return;
            }

            // Resolve each round
            for (const round of expiredRounds) {
                try {
                    await resolutionService.resolveRound(round.id, currentPrice);
                    logger.info(`Auto-resolved round ${round.id} with price ${currentPrice}`);
                } catch (error) {
                    logger.error(`Failed to auto-resolve round ${round.id}:`, error);
                }
            }
        } catch (error) {
            logger.error('Error in auto-resolution scheduler:', error);
        }
    }
}

export default new SchedulerService();
