import { Router, Request, Response, NextFunction } from 'express';
import { isValidStellarAddress } from '../services/stellar.service';
import hackathonService from '../services/hackathon.service';

const router = Router();

/**
 * @openapi
 * /api/user/{address}/stats:
 *   get:
 *     summary: Return per-wallet stats for a Stellar address
 *     tags:
 *       - user
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Wallet-specific stats
 *       400:
 *         description: Invalid wallet address
 */
router.get('/:address/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;

    if (!address || !isValidStellarAddress(address)) {
      return res.status(400).json({ error: 'Invalid Stellar wallet address format' });
    }

    // TODO: Wire to contract get_user_stats() and get_pending_winnings()
    const stats = await hackathonService.getUserStats(address);

    return res.json({
      address: stats.address,
      balance: stats.balance,
      pendingWinnings: stats.pendingWinnings,
      totalWins: stats.totalWins,
      totalLosses: stats.totalLosses,
      currentStreak: stats.currentStreak,
      xp: stats.xp,
      rankTitle: stats.rankTitle,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
