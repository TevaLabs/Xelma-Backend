import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.middleware";
import { joinTournamentParamsSchema, tournamentListQuerySchema } from "../schemas/tournament.schema";
import tournamentService from "../services/tournament.service";

const router = Router();

interface MockTournament {
  id: string;
  name: string;
  description: string;
  mode: "UP_DOWN" | "LEGENDS";
  status: "UPCOMING" | "ACTIVE" | "COMPLETED";
  entryFee: string;
  prizePool: string;
  maxParticipants: number;
  currentParticipants: number;
  startTime: string;
  endTime: string;
  rounds: number;
  createdAt: string;
}

const MOCK_TOURNAMENTS: MockTournament[] = [
  {
    id: "t-001",
    name: "XLM Prediction Championship",
    description:
      "Compete against the best predictors in a multi-round UP/DOWN tournament.",
    mode: "UP_DOWN",
    status: "ACTIVE",
    entryFee: "50",
    prizePool: "5000",
    maxParticipants: 100,
    currentParticipants: 67,
    startTime: "2026-06-25T10:00:00Z",
    endTime: "2026-06-28T10:00:00Z",
    rounds: 10,
    createdAt: "2026-06-20T12:00:00Z",
  },
  {
    id: "t-002",
    name: "Legends Weekly Showdown",
    description:
      "Range-based prediction tournament for experienced players. Weekly prizes.",
    mode: "LEGENDS",
    status: "UPCOMING",
    entryFee: "100",
    prizePool: "10000",
    maxParticipants: 50,
    currentParticipants: 12,
    startTime: "2026-07-01T00:00:00Z",
    endTime: "2026-07-07T23:59:59Z",
    rounds: 20,
    createdAt: "2026-06-22T08:00:00Z",
  },
  {
    id: "t-003",
    name: "Beginner Friendly Cup",
    description:
      "Low entry fee tournament perfect for newcomers. Learn and earn!",
    mode: "UP_DOWN",
    status: "COMPLETED",
    entryFee: "10",
    prizePool: "500",
    maxParticipants: 200,
    currentParticipants: 143,
    startTime: "2026-06-18T00:00:00Z",
    endTime: "2026-06-20T23:59:59Z",
    rounds: 5,
    createdAt: "2026-06-15T10:00:00Z",
  },
];

/**
 * GET /api/tournaments
 * List all tournaments with optional status and mode filters.
 */
router.get(
  "/",
  validate(tournamentListQuerySchema, "query"),
  (req: Request, res: Response, _next: NextFunction) => {
    const { limit, offset, status, mode } = req.query as unknown as {
      limit: number;
      offset: number;
      status?: "UPCOMING" | "ACTIVE" | "COMPLETED";
      mode?: "UP_DOWN" | "LEGENDS";
    };

    let filtered = MOCK_TOURNAMENTS;
    if (status) {
      filtered = filtered.filter((t) => t.status === status);
    }
    if (mode) {
      filtered = filtered.filter((t) => t.mode === mode);
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return res.json({
      success: true,
      data: paginated,
      pagination: { limit, offset, total },
    });
  },
);

/**
 * GET /api/tournaments/:id
 * Get tournament detail by id.
 */
router.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  const tournament = MOCK_TOURNAMENTS.find((t) => t.id === id);

  if (!tournament) {
    const { NotFoundError } = require("../utils/errors");
    return next(new NotFoundError("Tournament not found"));
  }

  return res.json({ success: true, data: tournament });
});

/**
 * POST /api/tournaments/:id/join
 * Join a tournament (authenticated).
 */
router.post(
  "/:id/join",
  authenticateUser,
  validate(joinTournamentParamsSchema, "params"),
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;
      const { id } = req.params;

      const result = await tournamentService.joinTournament(userId, id);

      res.json({
        success: true,
        data: {
          tournamentId: id,
          currentParticipants: result.currentParticipants,
        },
      });
    } catch (error) {
      next(error);
    }
  }) as any,
);

export default router;
