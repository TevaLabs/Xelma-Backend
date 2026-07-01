import { Router, Request, Response } from "express";
import { getRepositories } from "../repositories";
import { sendSuccess, sendError } from "../utils/response";

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
 * Fallback mode: when the data store is empty or unreachable, the response
 * still returns 200 with `"isFallback": true` so the landing page never
 * receives an error.  See src/data/mockData.ts for the documented fallback
 * constants and when to expect them.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const stats = await getRepositories().stats.getPlatformStats();
    return sendSuccess(res, stats);
  } catch (err) {
    console.error("[GET /api/stats] Unexpected error:", err);
    return sendError(res, "Failed to retrieve platform stats.", 500);
  }
});

export default router;
