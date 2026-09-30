import { Router, Request, Response } from "express";
import { getRepositories } from "../repositories";
import { sendSuccess, sendError } from "../utils/response";
import logger from "../utils/logger";
import { setPublicCache } from "../utils/http-cache";

const router = Router();

/**
 * @openapi
 * /api/stats:
 *   get:
 *     summary: Platform statistics
 *     description: Returns aggregated platform counters for the landing page.
 *     tags:
 *       - stats
 *     responses:
 *       200:
 *         description: Platform stats
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlatformStatsResponse'
 *       500:
 *         description: Failed to retrieve stats
 */

/**
 * GET /api/stats
 *
 * Returns aggregated platform counters for the landing page.
 *
 * Response shape:
 * {
 *   "success": true,
 *   "data": {
 *     "totalRounds": 142,
 *     "totalUsers":  89,
 *     "totalBets":  530,
 *     "isFallback": false,       // true when mock constants are being served
 *     "cachedAt":  "2026-06-27T12:00:00.000Z"
 *   }
 * }
 *
 * Cache TTL: 30 seconds (in-process).
 *
 * Behaviour:
 *   DATA_MODE=mock            → returns MOCK_PLATFORM_STATS with isFallback=true
 *   DATA_MODE=live (or unset) → queries the database:
 *     • DB has data           → live counts with isFallback=false
 *     • DB empty              → zero counts with isFallback=false
 *     • DB unreachable        → MOCK_PLATFORM_STATS with isFallback=true
 *
 * An empty production database returns legitimate zeros (isFallback=false)
 * so dashboards can distinguish "no data yet" from mock constants.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const stats = await getRepositories().stats.getPlatformStats();
    setPublicCache(res, 30);
    return sendSuccess(res, stats);
  } catch (err) {
    setPublicCache(res, 30);
    logger.error("[GET /api/stats] Unexpected error:", {
      error: err instanceof Error ? err.message : String(err),
    });
    return sendError(res, "Failed to retrieve platform stats.", 500);
  }
});

export default router;
