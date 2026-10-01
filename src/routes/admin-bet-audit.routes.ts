import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { betAuditService } from '../services/bet-audit.service';
import logger from '../utils/logger';

const router = Router();

/**
 * @openapi
 * /api/admin/bet-audit:
 *   get:
 *     summary: List recent bet-audit events
 *     description: |
 *       Returns bet-audit events with optional filtering by wallet address
 *       and configurable result limit. Sensitive fields (txHash) are
 *       redacted to partial values. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: address
 *         schema:
 *           type: string
 *         description: Filter events by wallet address
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *         description: Maximum number of events to return
 *     responses:
 *       200:
 *         description: Bet-audit event list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 events:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BetAuditEvent'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const address = typeof req.query.address === 'string' ? req.query.address : undefined;
    const limit = Math.min(
      parseInt(req.query.limit as string) || 50,
      100,
    );

    const events = await betAuditService.queryStoredEvents({ address, limit, redact: true });

    res.json({
      total: events.length,
      limit,
      events,
    });
  } catch (err) {
    logger.error('Bet-audit query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to query bet-audit events' });
  }
});

export default router;