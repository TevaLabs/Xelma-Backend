/**
 * Admin routes for the dead-letter queue (Issue #193). Lets an operator
 * inspect and replay notification/websocket dispatches that failed at
 * runtime, without needing shell or DB access.
 *
 * Gated by `requireAdmin`. All write actions return a structured summary so
 * a CI smoke test or an on-call runbook can assert against it.
 */
import { Router, Request, Response } from 'express';
import { DispatchChannel, DispatchStatus } from '@prisma/client';
import { requireAdmin } from '../middleware/auth.middleware';
import deadLetterQueueService, {
  RetryHandlers,
} from '../services/dead-letter-queue.service';
import notificationService from '../services/notification.service';
import websocketService from '../services/websocket.service';
import logger from '../utils/logger';
import auditLogger from '../utils/audit-logger';

const router = Router();

/**
 * Build retry handlers that delegate back into the existing dispatchers.
 * Lives in the route module on purpose: keeps the DLQ service free of a
 * compile-time dependency on the dispatchers (no import cycle).
 */
function buildRetryHandlers(): RetryHandlers {
  return {
    notificationCreate: async (payload) => {
      return notificationService.createNotificationForRetry(payload);
    },
    websocketEmit: ({ eventName, payload }) => {
      websocketService.replayEmit(eventName, payload);
    },
  };
}

function parseStatus(raw: unknown): DispatchStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.toUpperCase();
  return (Object.values(DispatchStatus) as string[]).includes(upper)
    ? (upper as DispatchStatus)
    : undefined;
}

function parseChannel(raw: unknown): DispatchChannel | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.toUpperCase();
  return (Object.values(DispatchChannel) as string[]).includes(upper)
    ? (upper as DispatchChannel)
    : undefined;
}

function parseInt32(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseDryRun(req: Request): boolean {
  const fromQuery = req.query.dryRun;
  if (fromQuery === 'true' || fromQuery === '1') return true;
  const fromBody = req.body?.dryRun;
  return fromBody === true || fromBody === 'true';
}

/**
 * @openapi
 * /api/admin/dead-letter:
 *   get:
 *     summary: List failed notification/event dispatches
 *     description: |
 *       Returns the dead-letter queue contents, newest first. Admin only.
 *       Use `?status=` and `?channel=` to filter; defaults to all rows.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { entries, total, limit, offset } = await deadLetterQueueService.list({
      status: parseStatus(req.query.status),
      channel: parseChannel(req.query.channel),
      limit: parseInt32(req.query.limit, 50),
      offset: parseInt32(req.query.offset, 0),
    });
    res.json({ entries, total, limit, offset });
  } catch (err) {
    logger.error('DLQ list failed', { error: err });
    res.status(500).json({ error: 'Failed to list dead-letter entries' });
  }
});

/**
 * @openapi
 * /api/admin/dead-letter/retry-all:
 *   post:
 *     summary: Replay every pending/retrying dispatch in the DLQ
 *     description: Admin only. Returns a counts summary.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
router.post('/retry-all', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = parseInt32(req.body?.limit ?? req.query?.limit, 50);
    const dryRun = parseDryRun(req);
    const result = await deadLetterQueueService.retryAll(
      buildRetryHandlers(),
      limit,
      undefined,
      { dryRun },
    );
    res.json(result);
  } catch (err) {
    logger.error('DLQ retry-all failed', { error: err });
    res.status(500).json({ error: 'Failed to replay dead-letter entries' });
  }
});

/**
 * @openapi
 * /api/admin/dead-letter/{id}/retry:
 *   post:
 *     summary: Replay a single DLQ entry
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/retry', requireAdmin, async (req: Request, res: Response) => {
  try {
    const dryRun = parseDryRun(req);
    const result = await deadLetterQueueService.retry(
      req.params.id,
      buildRetryHandlers(),
      undefined,
      { dryRun },
    );
    if (!result) {
      res.status(404).json({ error: 'Dead-letter entry not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error('DLQ retry failed', { error: err, id: req.params.id });
    res.status(500).json({ error: 'Failed to replay dead-letter entry' });
  }
});

/**
 * @openapi
 * /api/admin/dead-letter/{id}/abandon:
 *   post:
 *     summary: Abandon a single DLQ entry with an audit reason
 *     description: |
 *       Admin only. Marks the dead-letter queue entry as ABANDONED and logs
 *       an audit event with the supplied reason.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: DLQ entry ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for abandoning the dead-letter entry
 *     responses:
 *       200:
 *         description: Dead-letter entry abandoned successfully
 *       400:
 *         description: Missing or invalid reason
 *       404:
 *         description: Dead-letter entry not found
 *       500:
 *         description: Failed to abandon dead-letter entry
 */
router.post('/:id/abandon', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({ error: 'reason is required to abandon a dead-letter entry' });
      return;
    }

    const trimmedReason = reason.trim();
    const result = await deadLetterQueueService.abandon(req.params.id, trimmedReason);
    if (!result) {
      res.status(404).json({ error: 'Dead-letter entry not found' });
      return;
    }

    const adminUser = (req as any).user;
    const requestId = (req as any).requestId;
    const ipAddress = req.ip || req.socket?.remoteAddress;
    const userAgent = req.get('user-agent');

    auditLogger.logDlqAbandoned({
      dlqId: req.params.id,
      channel: result.channel,
      eventName: result.eventName,
      userId: result.userId,
      reason: trimmedReason,
      actorUserId: adminUser?.userId || adminUser?.id,
      actorWalletAddress: adminUser?.walletAddress,
      requestId,
      ipAddress,
      userAgent,
    });

    res.json({
      id: result.id,
      status: result.status,
      attempts: result.attempts,
      lastError: result.lastError,
    });
  } catch (err) {
    logger.error('DLQ abandon failed', { error: err, id: req.params.id });
    res.status(500).json({ error: 'Failed to abandon dead-letter entry' });
  }
});

export default router;
