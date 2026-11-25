import { Router, Request, Response } from 'express';
import { OutboxEventStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { rateLimitMetricsService } from '../services/rate-limit-metrics.service';
import payoutReconciliationService from '../services/payout-reconciliation.service';
import { requireAdmin, requireMetricsAuth } from '../middleware/auth.middleware';
import logger from '../utils/logger';
import { register } from 'prom-client';

const router = Router();

/**
 * @openapi
 * /api/admin/metrics/rate-limits:
 *   get:
 *     summary: Rate-limit activity summary
 *     description: |
 *       Returns statistics about rate-limit hits and operator-facing suspicious activity
 *       for auth, prediction, and chat endpoints. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of records to return for each category
 *     responses:
 *       200:
 *         description: Rate-limit metrics summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topEndpoints:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       endpoint:
 *                         type: string
 *                       hits:
 *                         type: integer
 *                 topAbusers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key:
 *                         type: string
 *                       endpoint:
 *                         type: string
 *                       hits:
 *                         type: integer
 *                 recentEvents:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       endpoint:
 *                         type: string
 *                       key:
 *                         type: string
 *                       ip:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                 suspiciousActivity:
 *                   type: object
 *                   description: Auth, prediction, and chat abuse heuristics for operators
 *                   properties:
 *                     lookbackHours:
 *                       type: integer
 *                     hitThreshold:
 *                       type: integer
 *                     byCategory:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           category:
 *                             type: string
 *                             enum: [auth, prediction, chat]
 *                           hits:
 *                             type: integer
 *                           uniqueKeys:
 *                             type: integer
 *                     flaggedActors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key:
 *                             type: string
 *                           endpoint:
 *                             type: string
 *                           hits:
 *                             type: integer
 *                           category:
 *                             type: string
 *                           userId:
 *                             type: string
 *                           ip:
 *                             type: string
 *                           lastSeenAt:
 *                             type: string
 *                             format: date-time
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/rate-limits', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const summary = await rateLimitMetricsService.getSummary(limit);
    res.json(summary);
  } catch (error) {
    logger.error('Error fetching rate-limit metrics:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch rate-limit metrics' });
  }
});

/**
 * @openapi
 * /api/admin/metrics/rate-limits/clear:
 *   post:
 *     summary: Clear old rate-limit metrics
 *     description: Deletes rate-limit records older than a specific number of days. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *         description: Clear records older than this many days
 *       - in: query
 *         name: endpoint
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional endpoint path filter to clear metrics only for a specific endpoint
 *     responses:
 *       200:
 *         description: Number of records deleted
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post('/rate-limits/clear', requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 7;
    const rawEndpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint.trim() : undefined;
    const endpoint = rawEndpoint ? rawEndpoint : undefined;
    const count = await rateLimitMetricsService.clearOldMetrics(days, endpoint);
    res.json({ message: 'Success', deletedCount: count, ...(endpoint ? { endpoint } : {}) });
  } catch (error) {
    logger.error('Error clearing rate-limit metrics:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to clear rate-limit metrics' });
  }
});

/**
 * @openapi
 * /api/admin/metrics/metrics:
 *   get:
 *     summary: Scrape Prometheus metrics
 *     description: |
 *       Returns standard flat text representations of all registered metrics.
 *       Requires an admin JWT or a valid METRICS_SCRAPE_TOKEN, matching the
 *       public /metrics scrape endpoint.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Prometheus text exposition format
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
// Path is relative to the /api/admin/metrics mount point. Listing the full
// path here as well produced /api/admin/metrics/admin/metrics/metrics.
// Auth is required so this duplicate scrape surface cannot expose
// limiter/user-activity numbers on the unauthenticated hackathon app.
router.get('/metrics', requireMetricsAuth, async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error('Error rendering Prometheus metrics:', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * @openapi
 * /api/admin/metrics/payout-reconciliation:
 *   get:
 *     summary: Payout claim ledger summary
 *     description: |
 *       Returns current payout-claim counts by status so operators can see
 *       stuck pending winnings (PENDING/SUBMITTED/FAILED) and claims flagged
 *       NEEDS_MANUAL_REVIEW by the payout reconciliation worker (Issue #492).
 *       Admin only. Prometheus counters are scraped from /api/admin/metrics/metrics.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payout claim counts by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:
 *                   type: object
 *                   additionalProperties:
 *                     type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/payout-reconciliation', requireAdmin, async (req: Request, res: Response) => {
  try {
    const summary = await payoutReconciliationService.getReconciliationSummary();
    res.json({ success: true, summary });
  } catch (error) {
    logger.error('Error fetching payout reconciliation summary:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch payout reconciliation summary' });
  }
});

/**
 * @openapi
 * /api/admin/metrics/rate-limit-summary:
 *   get:
 *     summary: Structured rate-limit metrics summary
 *     description: Returns an optimized JSON configuration payload detailing active counter maps. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Structured rate-limit metrics summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
router.get('/rate-limit-summary', requireAdmin, async (req: Request, res: Response) => {
  try {
    const metric = register.getSingleMetric('http_rate_limit_hits_total');
    const values = metric ? (await metric.get()).values : [];

    const summary = values.map(v => ({
      endpoint: v.labels.endpoint,
      method: v.labels.method,
      hits: v.value,
    }));

    res.json({
      metric: 'http_rate_limit_hits_total',
      summary,
    });
  } catch (error) {
    logger.error('Error fetching rate-limit summary:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch rate-limit summary' });
  }
});

/**
 * @openapi
 * /api/admin/metrics/outbox:
 *   get:
 *     summary: Outbox backlog metrics
 *     description: |
 *       Returns transactional outbox event counts grouped by status
 *       (PENDING, PROCESSING, PROCESSED, FAILED) and the age of the oldest
 *       unprocessed backlog event (PENDING or PROCESSING). Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Outbox backlog counts by status and oldest backlog age
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 countsByStatus:
 *                   type: object
 *                   properties:
 *                     PENDING:
 *                       type: integer
 *                     PROCESSING:
 *                       type: integer
 *                     PROCESSED:
 *                       type: integer
 *                     FAILED:
 *                       type: integer
 *                 total:
 *                   type: integer
 *                 backlogCount:
 *                   type: integer
 *                 oldestAgeSeconds:
 *                   type: integer
 *                   nullable: true
 *                 oldestBacklogEvent:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [PENDING, PROCESSING]
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     ageSeconds:
 *                       type: integer
 *                     ageMs:
 *                       type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/outbox', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [grouped, oldest] = await Promise.all([
      prisma.outboxEvent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.outboxEvent.findFirst({
        where: {
          status: { in: [OutboxEventStatus.PENDING, OutboxEventStatus.PROCESSING] },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    const countsByStatus: Record<OutboxEventStatus, number> = {
      [OutboxEventStatus.PENDING]: 0,
      [OutboxEventStatus.PROCESSING]: 0,
      [OutboxEventStatus.PROCESSED]: 0,
      [OutboxEventStatus.FAILED]: 0,
    };

    for (const row of grouped) {
      countsByStatus[row.status] = row._count._all;
    }

    const total = Object.values(countsByStatus).reduce((sum, count) => sum + count, 0);
    const backlogCount =
      countsByStatus[OutboxEventStatus.PENDING] + countsByStatus[OutboxEventStatus.PROCESSING];

    const nowMs = Date.now();
    const oldestAgeMs = oldest ? Math.max(0, nowMs - oldest.createdAt.getTime()) : null;
    const oldestAgeSeconds = oldestAgeMs !== null ? Math.floor(oldestAgeMs / 1000) : null;

    res.json({
      success: true,
      countsByStatus,
      total,
      backlogCount,
      oldestAgeSeconds,
      oldestBacklogEvent: oldest
        ? {
            id: oldest.id,
            status: oldest.status,
            createdAt: oldest.createdAt.toISOString(),
            ageSeconds: oldestAgeSeconds,
            ageMs: oldestAgeMs,
          }
        : null,
    });
  } catch (error) {
    logger.error('Error fetching outbox backlog metrics:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to fetch outbox backlog metrics' });
  }
});

export default router;
