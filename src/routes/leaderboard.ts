import { Router, Request, Response, NextFunction } from 'express';
import config from '../config';
import { getLeaderboard } from '../services/leaderboard.service';
import hackathonService from '../services/hackathon.service';

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
    if (config.app.dataMode === 'mock') {
      const leaderboard = await hackathonService.getLeaderboard();
      return res.json(leaderboard);
    }

    const result = await getLeaderboard(100, 0);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
