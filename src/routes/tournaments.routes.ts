import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler.middleware";
import {
  joinTournamentParamsSchema,
  tournamentListQuerySchema,
  TournamentListQuery,
} from "../schemas/tournament.schema";
import tournamentService from "../services/tournament.service";
import { NotFoundError } from "../utils/errors";
import { sendSuccess } from "../utils/response";

const router = Router();

/**
 * @openapi
 * /api/tournaments:
 *   get:
 *     tags: [tournaments]
 *     summary: List tournaments
 *     description: Supports optional mode and status filters with offset pagination.
 *     parameters:
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [UP_DOWN, LEGENDS]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [UPCOMING, ACTIVE, COMPLETED, CANCELLED]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated tournament list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Tournament'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     pagination:
 *                       type: object
 *                       required: [limit, offset, total]
 *                       properties:
 *                         limit: { type: integer }
 *                         offset: { type: integer }
 *                         total: { type: integer }
 *       400:
 *         description: Invalid mode or status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
  "/",
  validate(tournamentListQuerySchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as TournamentListQuery;
      const result = await tournamentService.listTournaments(query);
      return sendSuccess(res, result.data, { pagination: result.pagination });
    } catch (error) {
      return next(error);
    }
  },
);

/**
 * GET /api/tournaments/:id
 * Get tournament detail by id.
 */
router.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const tournament = tournamentService.getMockById(id);

  if (!tournament) {
    return next(new NotFoundError("Tournament not found"));
  }

  return sendSuccess(res, tournament);
});

/**
 * POST /api/tournaments/:id/join
 * Join a tournament (authenticated).
 */
router.post(
  "/:id/join",
  authenticateUser,
  validate(joinTournamentParamsSchema, "params"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.userId;
    const { id } = req.params;

    const result = await tournamentService.joinTournament(userId, id);

    return sendSuccess(res, {
      tournamentId: id,
      currentParticipants: result.currentParticipants,
    });
  }) as any,
);

export default router;
