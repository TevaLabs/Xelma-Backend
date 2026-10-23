import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { betAuditService } from '../services/bet-audit.service';
import { betService } from '../services/bet.service';
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

    const events = betAuditService.queryEvents({ address, limit, redact: true });

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

/**
 * @openapi
 * /api/admin/bets/reconciliation:
 *   get:
 *     summary: Bet reconciliation report for a round
 *     description: |
 *       Compares recorded bet totals against settled payouts for a given
 *       round and surfaces any mismatches. Admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: roundId
 *         required: true
 *         schema:
 *           type: string
 *         description: Round identifier to reconcile
 *     responses:
 *       200:
 *         description: Reconciliation report
 *       400:
 *         description: Missing or invalid roundId
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/reconciliation', requireAdmin, async (req: Request, res: Response) => {
  try {
    const roundId = typeof req.query.roundId === 'string' ? req.query.roundId.trim() : '';

    if (!roundId) {
      res.status(400).json({ error: 'roundId query parameter is required' });
      return;
    }

    const report = await betService.getReconciliationReport(roundId);

    res.json(report);
  } catch (err) {
    logger.error('Bet reconciliation report failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to generate reconciliation report' });
  }
});

export default router;