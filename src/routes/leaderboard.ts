import { Router, Request, Response, NextFunction } from 'express';
import { getRepositories } from '../repositories';
import { sendSuccess } from '../utils/response';

const router = Router();

/**
 * @openapi
 * /api/leaderboard:
 *   get:
 *     summary: Mock leaderboard rankings
 *     tags:
 *       - leaderboard
 *     responses:
 *       200:
 *         description: Top players by rank
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getRepositories().leaderboard.listLeaderboard(100, 0);
    const { pagination, ...data } = result as Record<string, unknown> & { pagination?: Record<string, unknown> };
    return sendSuccess(res, data, pagination ? { pagination } : undefined);
  } catch (err) {
    next(err);
  }
});

export default router;
