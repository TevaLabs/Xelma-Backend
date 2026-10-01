import { Router, Request, Response, NextFunction } from "express";
import roundService from "../services/round.service";
import resolutionService from "../services/resolution.service";
import simulationService from "../services/simulation.service";
import {
  requireAdmin,
  requireOracle,
  verifyStellarAuth,
  bindAuthenticatedWallet,
  AuthenticatedRequest,
} from "../middleware/auth.middleware";
import { asyncHandler } from "../middleware/errorHandler.middleware";
import { toDecimal } from "../utils/decimal.util";
import { serializeRound } from "../serializers/monetary.serializer";
import {
  adminRoundRateLimiter,
  betRateLimiter,
  oracleResolveRateLimiter,
} from "../middleware/rateLimiter.middleware";
import { validate } from "../middleware/validate.middleware";
import { sendSuccess } from "../utils/response";
import { startRoundSchema, resolveRoundSchema } from "../schemas/rounds.schema";
import {
  betSchema,
  upDownBetSchema,
  precisionBetSchema,
} from "../schemas/bets.schema";
import { NotFoundError } from "../utils/errors";
import { getRepositories } from "../repositories";
import config from "../config";
import { executeBet, BetKind } from "./bet-execution";

const router = Router();

/**
 * @openapi
 * /api/rounds:
 *   get:
 *     summary: List active prediction rounds
 *     description: Returns active rounds. Delegates to shared round service with Soroban → Database → Mock fallback.
 *     tags:
 *       - rounds
 *     responses:
 *       200:
 *         description: Active rounds with source metadata
 */
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Source fallback order: Soroban on-chain → database → mock data.
    // Controlled by roundService.getRoundsForApi(); see round.service.ts.
    const { source, rounds } = await roundService.getRoundsForApi();
    sendSuccess(res, {
      source,
      rounds: rounds.map((round) => serializeRound(round)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/rounds/start:
 *   post:
 *     summary: Start a new prediction round
 *     description: Admin-only. Starts a new round for a given mode, start price, and duration.
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: integer
 *                 description: 0 (UP_DOWN) or 1 (LEGENDS)
 *                 enum: [0, 1]
 *               startPrice:
 *                 type: number
 *                 description: Starting price (must be > 0)
 *               duration:
 *                 type: integer
 *                 description: Duration in seconds (must be > 0)
 *               priceRanges:
 *                 type: array
 *                 description: Optional LEGENDS-only custom ranges
 *                 items:
 *                   type: object
 *                   properties:
 *                     min: { type: number }
 *                     max: { type: number }
 *                   required: [min, max]
 *             required: [mode, startPrice, duration]
 *     responses:
 *       200:
 *         description: Round started
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       409:
 *         description: Conflict - active round exists
 */
router.post(
  "/start",
  requireAdmin,
  adminRoundRateLimiter,
  validate(startRoundSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { mode, startPrice, duration, priceRanges } = req.body;
    const gameMode = mode === 0 ? "UP_DOWN" : "LEGENDS";
    const round = await roundService.startRound(
      gameMode,
      startPrice,
      duration,
      priceRanges,
    );

    res.json({
      success: true,
      round: serializeRound({
        id: round.id,
        mode: round.mode,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        startPrice: round.startPrice,
        sorobanRoundId: round.sorobanRoundId,
        isSoroban: round.isSoroban,
        priceRanges: round.priceRanges,
      }),
    });
  }),
);

// NOTE: GET /active was removed — it duplicated GET / (both called
// roundService.getRoundsForApi()). Callers should use GET / instead.
// Kept here as a comment for discoverability; see issue #370.

/**
 * @swagger
 * /api/rounds/{id}:
 *   get:
 *     summary: Get a round by ID
 *     tags: [rounds]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Round found
 *       404:
 *         description: Round not found
 */
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const round = await roundService.getRound(id);

    if (!round) {
      return next(new NotFoundError("Round not found"));
    }

    res.json({
      success: true,
      round: serializeRound(round),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/rounds/{id}/bet:
 *   post:
 *     summary: Place a bet on a specific round
 *     description: >
 *       Round-scoped bet placement. The body shape selects the bet kind: a
 *       `side` places an UP/DOWN bet, a `predictedPrice` places a Precision
 *       bet. Runs through the same BetService execution path as
 *       `/api/bets/*`, so `BET_STUB_MODE` decides between recording a stub bet
 *       and submitting to Soroban, and on-chain failures surface as structured
 *       errors.
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         schema: { type: string }
 *         required: false
 *     responses:
 *       200:
 *         description: Bet recorded (stub) or placed on-chain
 *       400:
 *         description: Validation error, or round mode does not match the bet kind
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationErrorResponse'
 *             examples:
 *               ValidationError:
 *                 summary: Invalid bet payload
 *                 value:
 *                   error: "ValidationError"
 *                   message: "Amount must be a positive number"
 *                   code: "VALIDATION_ERROR"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *                   details:
 *                     - field: "amount"
 *                       message: "Amount must be greater than 0"
 *       401:
 *         description: Missing or invalid authentication token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnauthorizedResponse'
 *             examples:
 *               MissingToken:
 *                 summary: No bearer token provided
 *                 value:
 *                   error: "AuthenticationError"
 *                   message: "No token provided"
 *                   code: "AUTHENTICATION_ERROR"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *               InvalidToken:
 *                 summary: Expired or malformed bearer token
 *                 value:
 *                   error: "AuthenticationError"
 *                   message: "Invalid or expired token"
 *                   code: "AUTHENTICATION_ERROR"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *       403:
 *         description: Wallet address mismatch or forbidden action
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ForbiddenResponse'
 *             examples:
 *               WalletMismatch:
 *                 summary: Authenticated wallet mismatch
 *                 value:
 *                   error: "ForbiddenError"
 *                   message: "Authenticated wallet does not match the requested wallet"
 *                   code: "FORBIDDEN"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *       404:
 *         description: Round not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               RoundNotFound:
 *                 summary: Round not found
 *                 value:
 *                   error: "NotFoundError"
 *                   message: "Round not found"
 *                   code: "NOT_FOUND"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *       409:
 *         description: Idempotency conflict or round state conflict
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               IdempotencyConflict:
 *                 summary: Request in flight with same idempotency key
 *                 value:
 *                   error: "ConflictError"
 *                   message: "An identical request is currently being processed. Please retry shortly."
 *                   code: "IDEMPOTENCY_CONFLICT"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *             examples:
 *               RateLimited:
 *                 summary: Too many betting requests
 *                 value:
 *                   error: "RateLimitExceeded"
 *                   message: "Too many betting requests, please slow down"
 *                   code: "RATE_LIMIT_EXCEEDED"
 *                   path: "/api/rounds/round-123/bet"
 *                   requestId: "c2b4e891-6f34-4b5a-9a8c-2f9e4d5c6b7a"
 *                   timestamp: "2026-09-28T12:00:00.000Z"
 *                   retryAfter: 60
 */
router.post(
  "/:id/bet",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(betSchema),
  (async (req: Request, res: Response, next: NextFunction) => {
    // betSchema is a union: `side` means UP/DOWN, `predictedPrice` means Precision.
    const kind: BetKind =
      req.body.predictedPrice !== undefined ? "precision" : "up-down";

    await executeBet(req, res, next, {
      kind,
      endpoint: "/api/rounds/:id/bet",
      roundId: req.params.id,
    });
  }) as any,
);

/**
 * @swagger
 * /api/rounds/{id}/resolve:
 *   post:
 *     summary: Resolve a round with the final price
 *     description: Oracle-only. Resolves the round and computes winners.
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               finalPrice: { type: number }
 *             required: [finalPrice]
 *     responses:
 *       200:
 *         description: Round resolved
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Round not found
 */
router.post(
  "/:id/resolve",
  requireOracle,
  oracleResolveRateLimiter,
  validate(resolveRoundSchema),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { finalPrice } = req.body;

    const { outcome, round } = await resolutionService.resolveRound(
      id,
      toDecimal(finalPrice),
    );

    if (!round) {
      return res.status(404).json({ success: false, error: "Round not found" });
    }

    res.json({
      success: true,
      outcome,
      round: {
        ...serializeRound({
          id: round.id,
          status: round.status,
          startPrice: round.startPrice,
          endPrice: round.endPrice,
          resolvedAt: round.resolvedAt,
        }),
        predictions: round.predictions ? round.predictions.length : 0,
        winners: round.predictions
          ? round.predictions.filter((p: any) => p.won === true).length
          : 0,
      },
    });
  }),
);

/**
 * ENABLE_SIMULATION is the master switch for the QA simulate endpoint.
 * When it is off the route is locked down (403) in EVERY environment —
 * including development and test — so simulation can never run misconfigured.
 * When it is on, only ADMIN callers may use it (see requireAdmin below).
 */
const requireSimulationEnabled = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!config.app.enableSimulation) {
    res.status(403).json({
      success: false,
      error:
        "Simulation is disabled. Set ENABLE_SIMULATION=true to enable this QA endpoint.",
    });
    return;
  }
  next();
};

/**
 * @swagger
 * /api/rounds/{id}/simulate:
 *   post:
 *     summary: Simulate a round resolution (Non-Production QA Endpoint)
 *     description: >
 *       Simulates payout distribution for a round WITHOUT placing real bets or
 *       mutating the round. This is a QA/admin-only endpoint and must not be
 *       enabled on production builds. It is gated by the ENABLE_SIMULATION
 *       environment variable (default: false): when the flag is off the route
 *       returns 403 in EVERY environment, including development and test. When
 *       the flag is on, the caller must present an ADMIN bearer token
 *       (`Authorization: Bearer <JWT>`).
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Round ID to simulate
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               finalPrice:
 *                 type: number
 *                 description: Hypothetical final price used to compute winners
 *             required: [finalPrice]
 *     responses:
 *       200:
 *         description: Simulation results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 roundId: { type: string }
 *                 simulatedPrice: { type: number }
 *                 mode: { type: string, enum: [UP_DOWN, LEGENDS] }
 *                 startPrice: { type: number }
 *                 winningSide: { type: string, nullable: true, enum: [UP, DOWN] }
 *                 winningRange:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     min: { type: number }
 *                     max: { type: number }
 *                 predictions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       won: { type: boolean, nullable: true }
 *                       payout: { type: number }
 *                       amount: { type: number }
 *                       side: { type: string, nullable: true, enum: [UP, DOWN] }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     totalPredictions: { type: integer }
 *                     winners: { type: integer }
 *                     losers: { type: integer }
 *                     refunded: { type: integer }
 *                     totalPayout: { type: number }
 *       400:
 *         description: Validation error - finalPrice missing
 *       401:
 *         description: Unauthorized - missing or invalid bearer token
 *       403:
 *         description: Forbidden - simulation disabled (ENABLE_SIMULATION=false) or caller is not an admin
 *       404:
 *         description: Round not found
 */
router.post(
  "/:id/simulate",
  requireSimulationEnabled,
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { finalPrice } = req.body;

    if (finalPrice === undefined || finalPrice === null) {
      return res
        .status(400)
        .json({ success: false, error: "finalPrice is required" });
    }

    const result = await simulationService.simulateRound(id, finalPrice);
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Round not found" });
    }

    res.json({
      success: true,
      roundId: result.roundId,
      simulatedPrice: result.simulatedPrice,
      mode: result.mode,
      startPrice: result.startPrice,
      winningSide: result.winningSide,
      winningRange: result.winningRange,
      predictions: result.predictions,
      summary: result.summary,
    });
  }),
);

/**
 * Hackathon mutation endpoints.
 *
 * These are round-scoped aliases of `/api/bets/{up-down,precision}` and run
 * through the same BetService execution path, so pools, audit events and
 * on-chain placement stay consistent no matter which URL a demo client uses.
 * The hackathon round repository is still updated first so the in-memory
 * hackathon views keep reflecting the bet.
 */
router.post(
  "/hackathon/up-down/:id/bet",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(upDownBetSchema),
  (async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { address, amount, side } = req.body;

    try {
      await getRepositories().rounds.placeBet(id, address, amount, side);
    } catch (err) {
      return next(err);
    }

    await executeBet(req, res, next, {
      kind: "up-down",
      endpoint: "/api/rounds/hackathon/up-down/:id/bet",
      roundId: id,
    });
  }) as any,
);

router.post(
  "/hackathon/precision/:id/bet",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(precisionBetSchema),
  (async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { address, amount, predictedPrice } = req.body;

    try {
      await getRepositories().rounds.placeBet(
        id,
        address,
        amount,
        undefined,
        predictedPrice,
      );
    } catch (err) {
      return next(err);
    }

    await executeBet(req, res, next, {
      kind: "precision",
      endpoint: "/api/rounds/hackathon/precision/:id/bet",
      roundId: id,
    });
  }) as any,
);

export default router;
