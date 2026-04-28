import { Router, Request, Response } from 'express';
import { rateLimitMetricsService } from '../services/rate-limit-metrics.service';
import { requireAdmin } from '../middleware/auth.middleware';
import logger from '../utils/logger';

const router = Router();

/**
 * @openapi
 * /api/admin/metrics/rate-limits:
 *   get:
 *     summary: Rate-limit activity summary
 *     description: Returns statistics about rate-limit hits and potential abuse patterns. Admin only.
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
    const days = req.query.days ? parseInt(req.query.days as string) : 7;
    const count = await rateLimitMetricsService.clearOldMetrics(days);
    res.json({ message: 'Success', deletedCount: count });
  } catch (error) {
    logger.error('Error clearing rate-limit metrics:', error);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to clear rate-limit metrics' });
  }
});

export default router;
