import { Router, Request, Response, NextFunction } from 'express';
import { getRepositories } from '../repositories';
import { toLeaderboardContract } from '../utils/leaderboard-contract.util';
import { sendSuccess } from '../utils/response';

const router = Router();

/**
 * @openapi
 * /api/leaderboard:
 *   get:
 *     summary: Get leaderboard rankings
 *     description: |
 *       Returns the same leaderboard response contract in full and hackathon
 *       modes. Hackathon mode is public and uses seeded data; full mode accepts
 *       optional Bearer authentication to include userPosition.
 *     tags:
 *       - leaderboard
 *     responses:
 *       200:
 *         description: Shared leaderboard payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LeaderboardResponse'
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = 100;
    const offset = 0;
    const result = await getRepositories().leaderboard.listLeaderboard(limit, offset);
    return sendSuccess(res, toLeaderboardContract(result, limit, offset));
  } catch (err) {
    next(err);
  }
});

export default router;
