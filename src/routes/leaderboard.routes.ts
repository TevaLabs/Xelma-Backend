import { Router, Request, Response } from 'express';
import { getLeaderboard } from '../services/leaderboard.service';
import { optionalAuthentication, AuthRequest } from '../middleware/auth.middleware';

const router = Router();


//   GET /api/leaderboard
//  Get the global leaderboard with optional user position
 
//  Query Parameters:
//  - limit: number (default: 100, max: 500)
//  - offset: number (default: 0)
//  Returns leaderboard with user rankings and mode-specific stats

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
