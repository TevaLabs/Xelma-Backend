import { Router, Request, Response } from 'express';
import { getLeaderboard } from '../services/leaderboard.service';
import { optionalAuthentication, AuthRequest } from '../middleware/auth.middleware';

const router = Router();


/**
 * @swagger
 * /api/leaderboard:
 *   get:
 *     summary: Get the global leaderboard
 *     description: |
 *       Returns the global leaderboard. Bearer authentication is **optional**; if provided, the API may include the requesting user's position.\n
 *       Query params support pagination.
 *     tags: [leaderboard]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *         description: Max number of entries to return (max 500)
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Leaderboard payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LeaderboardResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example:
 *               error: Internal Server Error
 *               message: Failed to fetch leaderboard
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/leaderboard?limit=100&offset=0"
 */

router.get('/', optionalAuthentication, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.user?.userId;

    const leaderboard = await getLeaderboard(limit, offset, userId);

    res.json(leaderboard);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch leaderboard'
    });
  }
});

export default router;
