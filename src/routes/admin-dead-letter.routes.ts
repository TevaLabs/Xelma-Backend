/**
 * Admin routes for the dead-letter queue (Issue #193). Lets an operator
 * inspect and replay notification/websocket dispatches that failed at
 * runtime, without needing shell or DB access.
 *
 * Gated by `requireAdmin`. All write actions return a structured summary so
 * a CI smoke test or an on-call runbook can assert against it.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import deadLetterQueueService, {
  RetryHandlers,
} from '../services/dead-letter-queue.service';
import notificationService from '../services/notification.service';
import websocketService from '../services/websocket.service';
import { adminDeadLetterListQuerySchema } from '../schemas/dead-letter.schema';
import logger from '../utils/logger';

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
 *
 *       Paginated with the repo's canonical offset/limit meta. `limit` is
 *       capped at 100 (default 20) so the endpoint can never dump the whole
 *       table. Oversized payloads stored in the DLQ are truncated at 16 KiB
 *       and exposed with `truncated: true`.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Page size (1–100)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Rows to skip
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, RETRYING, RESOLVED, ABANDONED]
 *         description: Filter by dispatch status (case-insensitive)
 *       - in: query
 *         name: channel
 *         schema:
 *           type: string
 *           enum: [NOTIFICATION_CREATE, WEBSOCKET_EMIT]
 *         description: Filter by dispatch channel (case-insensitive)
 *     responses:
 *       200:
 *         description: Paginated dead-letter entries
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Missing or invalid token
 *       403:
 *         description: Admin access required
 */
router.get(
  '/',
  requireAdmin,
  validate(adminDeadLetterListQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const { limit, offset, status, channel } = req.query as unknown as {
        limit: number;
        offset: number;
        status?: 'PENDING' | 'RETRYING' | 'RESOLVED' | 'ABANDONED';
        channel?: 'NOTIFICATION_CREATE' | 'WEBSOCKET_EMIT';
      };
      const { data, pagination } = await deadLetterQueueService.list({
        status,
        channel,
        limit,
        offset,
      });
      res.json({ data, pagination });
    } catch (err) {
      logger.error('DLQ list failed', { error: err });
      res.status(500).json({ error: 'Failed to list dead-letter entries' });
    }
  },
);

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

export default router;
