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
 * @openapi
 * /api/tournaments:
 *   post:
 *     tags: [tournaments]
 *     summary: Create a tournament (start of the saga lifecycle)
 *     description: |
 *       Starts the tournament saga at UPCOMING. Subsequent lifecycle steps
 *       (join -> lock -> settle -> payout) are validated exclusively in the
 *       service layer, not in this route, so out-of-order requests fail with a
 *       structured bad-state rejection. Requires authentication.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, mode, entryFee, prizePool, maxParticipants, startTime, endTime, rounds]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               mode: { type: string, enum: [UP_DOWN, LEGENDS] }
 *               entryFee: { type: string }
 *               prizePool: { type: string }
 *               maxParticipants: { type: integer }
 *               startTime: { type: string, format: date-time }
 *               endTime: { type: string, format: date-time }
 *               rounds: { type: integer }
 *     responses:
 *       200:
 *         description: Tournament created
 *       400:
 *         description: Invalid tournament parameters
 *       401:
 *         description: Authentication required
 *       409:
 *         description: Lifecycle violation
 */
router.post(
  "/",
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const created = await tournamentService.createTournament(req.body);
    return sendSuccess(res, created);
  }),
);

/**
 * GET /api/tournaments/:id
 * Get tournament detail by id. Uses the mock seed for idempotent listing/detail
 * demos (as before); the saga write endpoints below are DB-backed via the service.
 */
router.get(
  "/:id",
  validate(joinTournamentParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    const tournament = tournamentService.getMockById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ success: false, error: "Tournament not found" });
    }
    return sendSuccess(res, tournament);
  }),
);

/**
 * @openapi
 * /api/tournaments/{id}/lock:
 *   post:
 *     tags: [tournaments]
 *     summary: Lock a tournament (close the join window)
 *     description: |
 *       Transitions the tournament UPCOMING -> ACTIVE, freezing registration
 *       before rounds begin. Validated by the saga state machine in the service.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Tournament locked
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tournament not found
 *       409:
 *         description: Lifecycle violation (e.g. locking a COMPLETED tournament)
 */
router.post(
  "/:id/lock",
  authenticateUser,
  validate(joinTournamentParamsSchema, "params"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await tournamentService.lockTournament(req.params.id);
    return sendSuccess(res, result);
  }),
);

/**
 * @openapi
 * /api/tournaments/{id}/settle:
 *   post:
 *     tags: [tournaments]
 *     summary: Settle a tournament and pay out winners
 *     description: |
 *       Transitions the tournament ACTIVE -> COMPLETED and distributes the prize
 *       pool deterministically based on the tied round leaderboard. The settle +
 *       payout is atomic and validated by the saga state machine.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Settlement completed with winner allocations
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tournament not found
 *       409:
 *         description: Lifecycle violation (e.g. settling an un-locked tournament)
 */
router.post(
  "/:id/settle",
  authenticateUser,
  validate(joinTournamentParamsSchema, "params"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await tournamentService.settleTournament(req.params.id);
    return sendSuccess(res, result);
  }),
);

/**
 * @openapi
 * /api/tournaments/{id}/cancel:
 *   post:
 *     tags: [tournaments]
 *     summary: Cancel a tournament
 *     description: |
 *       Transitions the tournament UPCOMING/ACTIVE -> CANCELLED. Terminal
 *       suppression: a COMPLETED tournament cannot be cancelled. Validated by
 *       the saga state machine in the service layer.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Tournament cancelled
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tournament not found
 *       409:
 *         description: Lifecycle violation (e.g. cancelling a COMPLETED tournament)
 */
router.post(
  "/:id/cancel",
  authenticateUser,
  validate(joinTournamentParamsSchema, "params"),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await tournamentService.cancelTournament(req.params.id);
    return sendSuccess(res, result);
  }),
);

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
  }),
);

export default router;