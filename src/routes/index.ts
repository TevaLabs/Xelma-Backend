import { Router } from 'express';
import { getPricesHandler } from './prices';

const router = Router();

/**
 * @openapi
 * /api/prices:
 *   get:
 *     summary: Multi-asset USD prices (BTC, ETH, XLM)
 *     description: |
 *       **Hackathon/demo price endpoint. Do not confuse with production `GET /api/price`.**
 *
 *       Returns BTC, ETH, and XLM spot prices (CoinGecko with a 30-second cache,
 *       or mock data when `DATA_MODE=mock`). Wrapped in the standard
 *       `{ success: true, data }` envelope — the same handler and envelope the
 *       production app serves on this path.
 *
 *       | Path | App | Purpose |
 *       |------|-----|---------|
 *       | `GET /api/prices` | Hackathon + production | Multi-asset ticker |
 *       | `GET /api/price` | Production only | Single-asset XLM oracle |
 *
 *       The hackathon app does **not** serve `/api/price`. Frontends targeting
 *       this demo API must use `/api/prices`. The two paths are **not** aliases
 *       and return different payloads on production.
 *     tags:
 *       - prices
 *     responses:
 *       200:
 *         description: Current market prices in the success envelope
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PriceResponse'
 *             example:
 *               success: true
 *               data:
 *                 BTC: 67420.12
 *                 ETH: 3241.55
 *                 XLM: 0.2891
 *                 stale: false
 *                 lastUpdatedAt: '2026-07-29T12:00:00.000Z'
 *       503:
 *         description: Price service unavailable (no cache and upstream failed)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, error]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: Unable to fetch prices and no cached data is available
 */
// The handler is owned by ./prices so both modes return the same envelope,
// failure shape and cache headers (#639); only the description above differs.
router.get('/prices', getPricesHandler);

export default router;
