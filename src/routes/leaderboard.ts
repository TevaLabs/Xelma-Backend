import { Router, Request, Response, NextFunction } from 'express';
import { getRepositories } from '../repositories';

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
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
