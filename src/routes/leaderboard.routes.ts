import { NextFunction, Request, Response, Router } from "express";
import {
  authenticateUser,
  AuthRequest,
  optionalAuthentication,
} from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { batchLeaderboardQuerySchema } from "../schemas/predictions.schema";
import {
  getBatchUserPositions,
  getLeaderboard,
} from "../services/leaderboard.service";

const router = Router();

/**
 * @swagger
 * /api/leaderboard:
 *   get:
 *     summary: Get the global leaderboard
 *     description: |
 *       Returns the global leaderboard. Bearer authentication is **optional**; if provided, the API may include the requesting user's position.\n
 *       Query params support pagination.
 *     tags: [leaderboard]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *         description: Max number of entries to return (max 500)
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Leaderboard payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LeaderboardResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example:
 *               error: Internal Server Error
 *               message: Failed to fetch leaderboard
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/leaderboard?limit=100&offset=0"
 */

router.get(
  "/",
  optionalAuthentication,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const userId = req.user?.userId;

      const leaderboard = await getLeaderboard(limit, offset, userId);

      res.json(leaderboard);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @swagger
 * /api/leaderboard/batch:
 *   post:
 *     summary: Get leaderboard positions for multiple users
 *     description: |
 *       Retrieve leaderboard positions and stats for multiple users in a single request.
 *       Each user lookup is processed independently. Partial success is supported.
 *       Maximum 100 user IDs per request.
 *     tags: [leaderboard]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 maxItems: 100
 *                 description: Array of user IDs to query
 *             required: [userIds]
 *           example:
 *             userIds: ["user-id-1", "user-id-2", "user-id-3"]
 *     responses:
 *       200:
 *         description: Batch user positions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: true if at least one query succeeded
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/BatchUserPositionResult'
 *             example:
 *               success: true
 *               results:
 *                 - userId: "user-id-1"
 *                   position:
 *                     rank: 15
 *                     userId: "user-id-1"
 *                     walletAddress: "GBRPY...4B"
 *                     totalEarnings: 125.50
 *                     totalPredictions: 42
 *                     accuracy: 73.81
 *                     modeStats:
 *                       upDown: { wins: 20, losses: 10, earnings: 85.25, accuracy: 66.67 }
 *                       legends: { wins: 12, losses: 8, earnings: 40.25, accuracy: 60.00 }
 *                 - userId: "user-id-2"
 *                   error: "User not found"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             examples:
 *               emptyUserIds:
 *                 value: { error: "At least one user ID is required" }
 *               tooManyUserIds:
 *                 value: { error: "Maximum 100 user IDs per query" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to fetch batch user positions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/leaderboard/batch" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"userIds":["user-id-1","user-id-2"]}'
 */
router.post(
  "/batch",
  authenticateUser,
  validate(batchLeaderboardQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userIds } = req.body;

      const results = await getBatchUserPositions(userIds);

      const successCount = results.filter((r) => r.position).length;

      res.json({
        success: successCount > 0,
        results,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
