import { Router, Request, Response } from "express";
import { getPlatformStats } from "../services/stats.service";

const router = Router();

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
    const stats = await getPlatformStats();
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    console.error("[GET /api/stats] Unexpected error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Failed to retrieve platform stats." });
  }
});

export default router;
