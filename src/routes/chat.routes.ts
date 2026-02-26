import { Router, Request, Response } from 'express';
import chatService from '../services/chat.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { chatMessageRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { sendMessageSchema } from '../schemas/chat.schema';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/chat/send
 * Send a new chat message (Authenticated users only, rate limited)
 *
 * Body: { content: string }
 * Response: { success: true, message: ChatMessage }
 */
router.post('/send', authenticateUser, chatMessageRateLimiter, validate(sendMessageSchema), async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    const userId = req.user!.userId;
    const walletAddress = req.user!.walletAddress;

    const message = await chatService.sendMessage(userId, walletAddress, content);

    res.status(201).json({
      success: true,
      message,
    });
  } catch (error: any) {
    logger.error('Failed to send chat message:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message || 'Failed to send message',
    });
  }
});

/**
 * GET /api/chat/history
 * Get chat history (last 50 messages)
 *
 * Query params:
 *   - limit: number (optional, default: 50, max: 50)
 *
 * Response: { success: true, messages: ChatMessage[], count: number }
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const requestedLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(requestedLimit, 50); // Cap at 50

    const messages = await chatService.getHistory(limit);

    res.json({
      success: true,
      messages,
      count: messages.length,
    });
  } catch (error: any) {
    logger.error('Failed to get chat history:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message || 'Failed to get chat history',
    });
  }
});

export default router;
