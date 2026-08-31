import { Router, Request, Response } from 'express';
import { getPrices } from '../services/priceService';
import { sendSuccess, sendError } from '../utils/response';
import priceOracle from '../services/oracle';

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
 *       The legacy single-asset XLM oracle endpoint lives on its own router so the
 *       app factory can gate it behind the `legacyPriceEndpoint` flag: the hackathon
 *       app serves `GET /api/prices` but must not expose `GET /api/price`.
 *       See src/app-factory.ts and docs/runtime-modes.md.
 */
export const legacyXlmPriceRouter = Router();

/**
 * @openapi
 * /api/prices:
 *   get:
 *     summary: Multi-asset USD prices (BTC, ETH, XLM)
 *     description: |
 *       **Do not confuse with `GET /api/price`.**
 *
 *       Returns live BTC, ETH, and XLM spot prices in USD (CoinGecko, 30-second
 *       in-memory cache). Use this for multi-asset price widgets and tickers.
 *
 *       | Path | Purpose | Typical client |
 *       |------|---------|----------------|
 *       | `GET /api/prices` | Multi-asset BTC / ETH / XLM | Price widgets, dashboards |
 *       | `GET /api/price` | Single-asset XLM oracle | Round resolution / oracle consumers |
 *
 *       Both paths are intentional and return **different payloads**. Prefer the
 *       path that matches the shape your client expects. Neither path is an alias
 *       of the other.
 *
 *       On the hackathon/demo app the same path is wrapped in the standard
 *       `{ success, data }` envelope (see hackathon OpenAPI).
 *     tags:
 *       - prices
 *     responses:
 *       200:
 *         description: Current market prices
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/PriceResponse'
 *       503:
 *         description: Price service unavailable (no cache and upstream failed)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                 message:
 *                   type: string
 *                 stale:
 *                   type: boolean
 *                 lastUpdatedAt:
 *                   type: string
 *                   nullable: true
 *                 source:
 *                   type: string
 *                   nullable: true
 */
router.get('/prices', async (_req: Request, res: Response) => {
  try {
    const snapshot = await getPrices();
    sendSuccess(res, snapshot);
  } catch (error) {
    sendError(
      res,
      error instanceof Error
        ? error.message
        : 'Unable to fetch prices and no cached data is available',
      503
    );
  }
});

/**
 * @openapi
 * /api/price:
 *   get:
 *     summary: Single-asset XLM oracle price
 *     description: |
 *       **Do not confuse with `GET /api/prices`.**
 *
 *       Production oracle endpoint for the current XLM/USD price as a precise
 *       decimal string, plus staleness / provider metadata. Use this when you
 *       need the oracle feed (not the multi-asset CoinGecko ticker).
 *
 *       | Path | Purpose | Typical client |
 *       |------|---------|----------------|
 *       | `GET /api/price` | Single-asset XLM oracle | Round resolution / oracle consumers |
 *       | `GET /api/prices` | Multi-asset BTC / ETH / XLM | Price widgets, dashboards |
 *
 *       **Availability:** served by the production app (`src/index.ts`). The
 *       hackathon/demo app does **not** expose this path — use `GET /api/prices`
 *       there instead.
 *
 *       **Deprecation note:** like other unversioned `/api/*` routes on the
 *       production app, responses include `Deprecation` / `Sunset` headers
 *       pointing at a future `/api/v1` successor. There is intentionally no
 *       `/api/v1/price` mirror yet (`GET /price` is on the versioned-alias
 *       allowlist). `/api/price` and `/api/prices` are **not** deprecated
 *       relative to each other — they remain separate contracts.
 *     tags:
 *       - prices
 *     responses:
 *       200:
 *         description: Current XLM oracle price snapshot
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/XlmOraclePriceResponse'
 *             example:
 *               asset: XLM
 *               price_usd: '0.28910000'
 *               stale: false
 *               provider: coingecko
 *               lastUpdatedAt: '2026-07-29T12:00:00.000Z'
 *               source: live
 *               timestamp: '2026-07-29T12:00:05.000Z'
 */
legacyXlmPriceRouter.get('/price', (_req: Request, res: Response) => {
  const price = priceOracle.getPriceString();
  const lastUpdatedAt = priceOracle.getLastUpdatedAt();
  res.json({
    asset: 'XLM',
    price_usd: price,
    stale: priceOracle.isStale(),
    provider: priceOracle.getLastProvider(),
    lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
    source: priceOracle.getActiveSource(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
