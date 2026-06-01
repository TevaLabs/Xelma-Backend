import { Router, Request, Response, NextFunction } from 'express';
import chatService from '../services/chat.service';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.middleware';
import { chatMessageRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { sendMessageSchema } from '../schemas/chat.schema';

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
 * GET /api/chat/history
 * Get chat history (last 50 messages)
 *
 * Query params:
 *   - limit: number (optional, default: 50, max: 50)
 *
 * Response: { success: true, messages: ChatMessage[], count: number }
 */
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(requestedLimit, 50); // Cap at 50

    const messages = await chatService.getHistory(limit);

    res.json({
      success: true,
      messages,
      count: messages.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
