import { Router, Request, Response } from 'express';
import { getPrices } from '../services/priceService';
import { sendSuccess, sendError } from '../utils/response';
import priceOracle from '../services/oracle';
import { setPublicCache, pricesCacheTtlSeconds } from '../utils/http-cache';

const router = Router();

/**
 * The legacy single-asset XLM oracle endpoint lives on its own router so the
 * app factory can gate it behind the `legacyPriceEndpoint` flag: the hackathon
 * app serves `GET /api/prices` but must not expose `GET /api/price`.
 * See src/app-factory.ts and docs/runtime-modes.md.
 */
export const legacyXlmPriceRouter = Router();

/**
 * Single owner of the `GET /api/prices` contract (#639).
 *
 * Both the full and hackathon apps route to this handler, so the success
 * envelope, the 503 failure envelope and the Cache-Control header cannot
 * drift between modes. The hackathon router (`src/routes/index.ts`) only
 * adds its own OpenAPI description on top.
 */
export async function getPricesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const snapshot = await getPrices();
    setPublicCache(res, pricesCacheTtlSeconds());
    sendSuccess(res, snapshot);
  } catch (error) {
    setPublicCache(res, pricesCacheTtlSeconds());
    sendError(
      res,
      error instanceof Error
        ? error.message
        : 'Unable to fetch prices and no cached data is available',
      503
    );
  }
}

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
 *       The response is wrapped in the standard `{ success, data }` envelope.
 *       The hackathon/demo app serves this same handler, so the envelope is
 *       identical in both modes.
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
router.get('/prices', getPricesHandler);

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
  setPublicCache(res, pricesCacheTtlSeconds());
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
