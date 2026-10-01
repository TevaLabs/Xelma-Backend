import { Router, Request, Response, NextFunction } from 'express';
import { getRepositories } from '../repositories';
import { sendSuccess } from '../utils/response';
import { adaptMockLeaderboardUser } from '../services/leaderboard.service';
import { MockLeaderboardUser } from '../data/mockData';
import { LeaderboardEntry } from '../types/leaderboard.types';

const router = Router();

/**
 * @openapi
 * /api/leaderboard:
 *   get:
 *     summary: Get hackathon/mock leaderboard rankings
 *     tags:
 *       - leaderboard
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *         description: Max number of entries to return
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Unified leaderboard response payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LeaderboardResponse'
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit
      ? Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 500)
      : 100;
    const offset = req.query.offset
      ? Math.max(parseInt(String(req.query.offset), 10) || 0, 0)
      : 0;

    const result = await getRepositories().leaderboard.listLeaderboard(limit, offset);

    let entries: LeaderboardEntry[];
    let totalUsers: number;

    if (Array.isArray(result)) {
      entries = (result as MockLeaderboardUser[]).map(adaptMockLeaderboardUser);
      totalUsers = entries.length + offset;
    } else if (result && typeof result === 'object' && 'leaderboard' in result) {
      entries = (result as { leaderboard: LeaderboardEntry[] }).leaderboard;
      totalUsers = (result as { totalUsers: number }).totalUsers;
    } else {
      entries = [];
      totalUsers = 0;
    }

    const pagination = {
      limit,
      offset,
      total: totalUsers,
      hasNextPage: offset + limit < totalUsers,
    };

    return sendSuccess(
      res,
      {
        leaderboard: entries,
        totalUsers,
        lastUpdated: new Date().toISOString(),
        pagination,
      },
      { pagination },
    );
  } catch (err) {
    next(err);
  }
});

export default router;
