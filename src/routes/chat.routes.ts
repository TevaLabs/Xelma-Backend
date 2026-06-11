import { Router, Request, Response, NextFunction } from 'express';
import chatService from '../services/chat.service';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.middleware';
import { chatMessageRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { sendMessageSchema } from '../schemas/chat.schema';
import { unifiedPaginationSchema } from '../schemas/pagination.schema';
import { ValidationError } from '../utils/errors';

const router = Router();

/**
 * @openapi
 * /api/chat/send:
 *   post:
 *     tags: [Chat]
 *     summary: Send a chat message
 *     description: |
 *       Authenticated users only. Rate limit: **5 messages per minute per user**. On limit, responds with **429**.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message created
 *       429:
 *         description: Too many messages
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 */
router.post('/send', authenticateUser, chatMessageRateLimiter, validate(sendMessageSchema), (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body;
    const { userId, walletAddress } = req.user;

    const message = await chatService.sendMessage(userId, walletAddress, content);

    res.status(201).json({
      success: true,
      message,
    });
  } catch (error) {
    next(error);
  }
}) as any);

/**
 * @openapi
 * /api/chat/history:
 *   get:
 *     tags: [Chat]
 *     summary: Get chat history
 *     description: |
 *       Returns recent chat messages. Supports two pagination modes:
 *
 *       **Cursor mode** (recommended for real-time chat): pass `cursor` from a
 *       previous response to load the next (older) page. Messages are returned
 *       oldest-first within each page.
 *
 *       **Offset mode**: pass `offset` to skip rows. Backward-compatible with
 *       existing clients that only pass `limit`.
 *
 *       When `cursor` is present, offset is ignored.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 50 }
 *         description: Number of messages per page (max 50)
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Opaque cursor from pagination.nextCursor (cursor mode)
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *         description: Number of rows to skip (offset mode, ignored when cursor is present)
 *     responses:
 *       200:
 *         description: Chat history page
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatHistoryResponse'
 *       400:
 *         description: Validation error
 */
router.get('/history', validate(unifiedPaginationSchema, 'query'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // After validate() the query is coerced and typed
    const { limit: rawLimit, offset, cursor } = req.query as unknown as {
      limit: number;
      offset: number;
      cursor?: string;
    };

    // Chat history caps at 50 messages per page
    const limit = Math.min(rawLimit, 50);

    if (cursor) {
      // Cursor mode
      const result = await chatService.getHistoryCursor(limit, cursor);
      return res.json({
        success: true,
        messages: result.data,
        pagination: result.pagination,
      });
    }

    // Offset mode (backward-compatible: if neither cursor nor offset is
    // provided, offset defaults to 0 and we return the latest messages)
    const result = await chatService.getHistoryOffset(limit, offset);
    return res.json({
      success: true,
      messages: result.data,
      pagination: result.pagination,
      // Legacy fields kept for backward compatibility
      count: result.data.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
