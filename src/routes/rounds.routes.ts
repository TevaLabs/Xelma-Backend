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
import { serializeRound, serializeSimulationResult } from "../serializers/monetary.serializer";
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
 *     description: |
 *       Admin-only. Starts a new round for a given mode, start price, and duration.\n
 *       `mode: 0` starts an UP_DOWN round; `mode: 1` starts a LEGENDS round, which
 *       requires at least two non-overlapping `priceRanges`. The server rejects a
 *       second start while a round is already active.\n
 *       Requires an Admin JWT (`403` for USER/ORACLE tokens) and is rate limited
 *       per IP; on limit it responds `429` with a `Retry-After` header.
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
 *                 description: Optional LEGENDS-only custom ranges (min 2, must not overlap)
 *                 items:
 *                   type: object
 *                   properties:
 *                     min: { type: number }
 *                     max: { type: number }
 *                   required: [min, max]
 *             required: [mode, startPrice, duration]
 *           examples:
 *             upDown:
 *               summary: Minimal UP_DOWN round
 *               value: { mode: 0, startPrice: 0.23, duration: 60 }
 *             legends:
 *               summary: LEGENDS round with custom ranges
 *               value:
 *                 mode: 1
 *                 startPrice: 0.23
 *                 duration: 120
 *                 priceRanges:
 *                   - { min: 0.2, max: 0.22 }
 *                   - { min: 0.22, max: 0.24 }
 *     responses:
 *       200:
 *         description: Round started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, round]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 round:
 *                   type: object
 *                   required: [id, mode, status, startTime, endTime, startPrice]
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     mode: { type: string, enum: [UP_DOWN, LEGENDS] }
 *                     status: { type: string, enum: [ACTIVE, LOCKED, RESOLVED] }
 *                     startTime: { type: string, format: date-time }
 *                     endTime: { type: string, format: date-time }
 *                     startPrice: { type: string, description: Decimal(20,8) string }
 *                     priceRanges:
 *                       type: array
 *                       nullable: true
 *                       items:
 *                         type: object
 *                         properties:
 *                           min: { type: number }
 *                           max: { type: number }
 *       400:
 *         description: Validation error (bad mode, non-positive price/duration, overlapping LEGENDS ranges)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: Validation error
 *               message: 'Invalid start price'
 *               code: VALIDATION_ERROR
 *               path: /api/rounds/start
 *       401:
 *         description: Missing or invalid JWT
 *         content:
 *           application/json:
 *             example:
 *               error: No token provided
 *       403:
 *         description: Authenticated but not an Admin
 *         content:
 *           application/json:
 *             example:
 *               error: Admin access required
 *       409:
 *         description: Conflict - an active round already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many round-start requests from this IP
 *         headers:
 *           Retry-After:
 *             schema: { type: integer }
 *             description: Seconds to wait before retrying
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/rounds/start" \\
 *             -H "Authorization: Bearer $ADMIN_TOKEN" \\
 *             -H "Content-Type: application/json" \\
 *             -d '{"mode":0,"startPrice":0.23,"duration":60}'
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
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Wallet address mismatch
 *       404:
 *         description: Round not found
 *       409:
 *         description: Idempotency key conflict
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
 * @swagger
 * /api/rounds/{id}/cancel:
 *   post:
 *     summary: Cancel a round and refund its participants
 *     description: >
 *       Admin-only. Cancels an ACTIVE or LOCKED round and refunds every settled
 *       participant inside a single database transaction, writing the matching
 *       outbox events atomically. Idempotent: cancelling an already-CANCELLED
 *       round returns `already_cancelled` without refunding anyone. A RESOLVED
 *       round cannot be cancelled.
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Round cancelled (or already cancelled)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 outcome:
 *                   type: string
 *                   enum: [updated, already_cancelled]
 *                 refundedCount: { type: integer }
 *                 refundedTotal: { type: string, description: "XLM amount as a decimal string" }
 *                 round: { type: object }
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Forbidden - caller is not an Admin
 *       404:
 *         description: Round not found
 *       409:
 *         description: Conflict - round is already resolved or not cancellable
 */
router.post(
  "/:id/cancel",
  requireAdmin,
  adminRoundRateLimiter,
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await roundService.cancelRound(req.params.id);

    res.json({
      success: true,
      outcome: result.outcome,
      refundedCount: result.refundedCount,
      refundedTotal: result.refundedTotal.toFixed(8),
      round: result.round
        ? serializeRound({
            id: result.round.id,
            mode: result.round.mode,
            status: result.round.status,
            startTime: result.round.startTime,
            endTime: result.round.endTime,
            startPrice: result.round.startPrice,
            endPrice: result.round.endPrice,
            resolvedAt: result.round.resolvedAt,
            sorobanRoundId: result.round.sorobanRoundId,
            isSoroban: result.round.isSoroban,
            priceRanges: result.round.priceRanges,
          })
        : null,
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
 *                 startPrice: { $ref: '#/components/schemas/MoneyAmount' }
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
 *                       payout: { $ref: '#/components/schemas/MoneyAmount' }
 *                       amount: { $ref: '#/components/schemas/MoneyAmount' }
 *                       side: { type: string, nullable: true, enum: [UP, DOWN] }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     totalPredictions: { type: integer }
 *                     winners: { type: integer }
 *                     losers: { type: integer }
 *                     refunded: { type: integer }
 *                     totalPayout: { $ref: '#/components/schemas/MoneyAmount' }
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

    const serialized = serializeSimulationResult(result);
    res.json({
      success: true,
      roundId: serialized.roundId,
      simulatedPrice: serialized.simulatedPrice,
      mode: serialized.mode,
      startPrice: serialized.startPrice,
      winningSide: serialized.winningSide,
      winningRange: serialized.winningRange,
      predictions: serialized.predictions,
      summary: serialized.summary,
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

    // `id` names a hackathon demo round (hackathon_rounds), not a `Round`
    // row, so it is not forwarded to BetService — which would 404 on it.
    // BetService binds the bet to the newest ACTIVE round of the mode, as
    // for /api/bets/*; the per-round demo view was updated just above.
    await executeBet(req, res, next, {
      kind: "up-down",
      endpoint: "/api/rounds/hackathon/up-down/:id/bet",
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

    // `id` names a hackathon demo round (hackathon_rounds), not a `Round`
    // row, so it is not forwarded to BetService — which would 404 on it.
    // BetService binds the bet to the newest ACTIVE round of the mode, as
    // for /api/bets/*; the per-round demo view was updated just above.
    await executeBet(req, res, next, {
      kind: "precision",
      endpoint: "/api/rounds/hackathon/precision/:id/bet",
    });
  }) as any,
);

export default router;
