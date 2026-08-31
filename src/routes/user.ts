import { Router, Request, Response, NextFunction } from 'express';
import { validateStellarAddressParam } from '../utils/stellar-address.util';
import hackathonService from '../services/hackathon.service';
import sorobanService from '../services/soroban.service';
import logger from '../utils/logger';
import { serializeMoney } from '../utils/decimal.util';
import { serializeUserBalance } from '../serializers/monetary.serializer';
import { sendSuccess } from '../utils/response';
import { computeXp, computeRankTitle } from '../utils/user-rank.util';

const router = Router();

/**
 * @openapi
 * /api/user/{address}/stats:
 *   get:
 *     summary: Return per-wallet stats for a Stellar address
 *     description: >
 *       Returns user stats from the Soroban contract when configured
 *       (SOROBAN_CONTRACT_ID set). Falls back to the database / mock data
 *       when Soroban is unavailable — the fallback path is documented in
 *       src/services/soroban.service.ts FAILURE POLICY.
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
 *         description: Wallet-specific stats matching production profile contract
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalWins:
 *                       type: integer
 *                     totalLosses:
 *                       type: integer
 *                     currentStreak:
 *                       type: integer
 *                     pendingWinnings:
 *                       $ref: '#/components/schemas/MoneyAmount'
 *                     isRegistered:
 *                       type: boolean
 *                 profile:
 *                   type: object
 *                   properties:
 *                     balance:
 *                       $ref: '#/components/schemas/MoneyAmount'
 *                     xp:
 *                       type: integer
 *                     rankTitle:
 *                       type: string
 *       400:
 *         description: Invalid wallet address
 */
router.get('/:address/stats', validateStellarAddressParam('address'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;

    // ── Live Soroban path (when configured) ─────────────────────────────────
    // Try to read on-chain stats, pending winnings, and balance in parallel.
    // Each method returns null / 0 when Soroban is not initialized, triggering
    // the fallback path below.
    const [contractStats, pendingWinnings, balance] = await Promise.all([
      sorobanService.getUserStats(address),
      sorobanService.getPendingWinnings(address),
      sorobanService.getBalance(address),
    ]);

    if (contractStats) {
      // On-chain data available — compute derived fields locally
      logger.info('Returning on-chain user stats', { address });

      const xp = computeXp(contractStats.total_wins, contractStats.best_streak);
      // Convert pending winnings from stroops to XLM for the response
      const pendingWinningsXlm = serializeMoney(Number(pendingWinnings) / 10_000_000);

      return sendSuccess(res, {
        address,
        balance: serializeMoney(balance),
        pendingWinnings: pendingWinningsXlm,
        totalWins: contractStats.total_wins,
        totalLosses: contractStats.total_losses,
        currentStreak: contractStats.current_streak,
        xp,
        rankTitle: computeRankTitle(xp),
      });
    }

    // ── Fallback path (Soroban not configured or unavailable) ────────────────
    // When the Soroban service is not initialized (SOROBAN_CONTRACT_ID unset,
    // or RPC unreachable) we fall back to the database or mock data via
    // hackathonService. This guarantees the endpoint always returns sensible
    // values, even if the contract integration is not wired up.
    logger.info('Soroban unavailable — returning DB/mock stats', { address });
    const stats = await hackathonService.getUserStats(address);

    return sendSuccess(res, serializeUserBalance({
      address: stats.address,
      balance: stats.balance,
      pendingWinnings: stats.pendingWinnings,
      totalWins: stats.totalWins,
      totalLosses: stats.totalLosses,
      currentStreak: stats.currentStreak,
      xp: stats.xp,
      rankTitle: stats.rankTitle,
    }));
  } catch (error) {
    next(error);
  }
});

export default router;
