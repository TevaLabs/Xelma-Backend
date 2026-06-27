import { Router } from 'express';
import { getPrices } from '../services/priceService';
import { asyncHandler } from '../middleware/errorHandler.middleware';

const router = Router();

/**
 * @openapi
 * /api/prices:
 *   get:
 *     summary: Live BTC, ETH, and XLM prices
 *     description: |
 *       Fetches USD prices from CoinGecko with a 30-second in-memory cache.
 *       When CoinGecko is temporarily unavailable, returns the last cached
 *       values with `stale: true`.
 *     tags:
 *       - prices
 *     responses:
 *       200:
 *         description: Current market prices
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PriceResponse'
 *       503:
 *         description: Price service unavailable (no cache)
 */
router.get(
  '/prices',
  asyncHandler(async (_req, res) => {
    const prices = await getPrices();
    res.json(prices);
  })
);

export default router;
