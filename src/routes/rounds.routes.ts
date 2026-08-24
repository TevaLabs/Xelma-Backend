import { Router, Request, Response, NextFunction } from 'express';
import roundService from '../services/round.service';
import resolutionService from '../services/resolution.service';
import simulationService from '../services/simulation.service';
import { requireAdmin, requireOracle, AuthenticatedRequest } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import { toDecimal, toDecimalString } from '../utils/decimal.util';
import { betRateLimiter, adminRoundRateLimiter, oracleResolveRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { sendSuccess } from '../utils/response';
import { startRoundSchema, resolveRoundSchema } from '../schemas/rounds.schema';
import { betSchema, upDownBetSchema, precisionBetSchema } from '../schemas/bets.schema';
import { NotFoundError } from '../utils/errors';
import { getRepositories } from '../repositories';
import config from '../config';

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
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { source, rounds } = await roundService.getRoundsForApi();
    sendSuccess(res, { source, rounds });
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
router.post('/start', requireAdmin, adminRoundRateLimiter, validate(startRoundSchema), asyncHandler((async (req: AuthenticatedRequest, res: Response) => {
    const { mode, startPrice, duration, priceRanges } = req.body;
    const gameMode = mode === 0 ? 'UP_DOWN' : 'LEGENDS';
    const round = await roundService.startRound(
      gameMode,
      startPrice,
      duration,
      priceRanges,
    );

    res.json({
        success: true,
        round: {
            id: round.id,
            mode: round.mode,
            status: round.status,
            startTime: round.startTime,
            endTime: round.endTime,
            startPrice: toDecimalString(round.startPrice),
            sorobanRoundId: round.sorobanRoundId,
            isSoroban: round.isSoroban,
            priceRanges: round.priceRanges,
        },
    });
}) as any));

/**
 * @swagger
 * /api/rounds/active:
 *   get:
 *     summary: Get active rounds
 *     description: Returns active rounds. Delegates to shared round service with fallback chain.
 *     tags: [rounds]
 *     responses:
 *       200:
 *         description: Active rounds
 */
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { source, rounds } = await roundService.getRoundsForApi();

        const serializedRounds = rounds.map((round: any) => ({
            ...round,
            startPrice: toDecimalString(round.startPrice),
            endPrice: round.endPrice !== null && round.endPrice !== undefined ? toDecimalString(round.endPrice) : null,
            poolUp: toDecimalString(round.poolUp),
            poolDown: toDecimalString(round.poolDown),
        }));

        res.json({
            success: true,
            source,
            rounds: serializedRounds,
        });
    } catch (error) {
        next(error);
    }
});

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
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;

        const round = await roundService.getRound(id);

        if (!round) {
            return next(new NotFoundError('Round not found'));
        }

         res.json({
            success: true,
            round: {
                ...round,
                startPrice: toDecimalString(round.startPrice),
                endPrice: round.endPrice !== null && round.endPrice !== undefined ? toDecimalString(round.endPrice) : null,
                poolUp: toDecimalString(round.poolUp),
                poolDown: toDecimalString(round.poolDown),
                predictions: round.predictions?.map((p: any) => ({
                    ...p,
                    amount: toDecimalString(p.amount),
                    payout: p.payout !== null && p.payout !== undefined ? toDecimalString(p.payout) : null,
                })),
            },
        });
    } catch (error) {
        next(error);
    }
});

// Stub bet endpoint — for logging/analytics only; on-chain bets go via Soroban
router.post('/:id/bet', betRateLimiter, validate(betSchema), (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Bet recorded (stub)' });
});

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
router.post('/:id/resolve', requireOracle, oracleResolveRateLimiter, validate(resolveRoundSchema), asyncHandler((async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const { finalPrice } = req.body;

    const { outcome, round } = await resolutionService.resolveRound(id, toDecimal(finalPrice));

    if (!round) {
        return res.status(404).json({ success: false, error: "Round not found" });
    }

    res.json({
        success: true,
        outcome,
        round: {
            id: round.id,
            status: round.status,
            startPrice: toDecimalString(round.startPrice),
            endPrice: round.endPrice !== null && round.endPrice !== undefined ? toDecimalString(round.endPrice) : null,
            resolvedAt: round.resolvedAt,
            predictions: round.predictions ? round.predictions.length : 0,
            winners: round.predictions ? round.predictions.filter((p: any) => p.won === true).length : 0,
        },
    });
}) as any));

/**
 * @swagger
 * /api/rounds/{id}/simulate:
 *   post:
 *     summary: Simulate a round resolution (Non-Production QA Endpoint)
 *     description: Simulates payout distribution without placing real bets or mutating the round. Disabled in production unless ENABLE_SIMULATION=true.
 *     tags: [rounds]
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
 *         description: Simulation results
 *       400:
 *         description: Validation error
 *       403:
 *         description: Disabled in production
 *       404:
 *         description: Round not found
 */
router.post('/:id/simulate', async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (config.app.nodeEnv === 'production' && !config.app.enableSimulation) {
            return res.status(403).json({ success: false, error: 'Simulation disabled in production unless ENABLE_SIMULATION=true' });
        }

        const { id } = req.params;
        const { finalPrice } = req.body;

        if (finalPrice === undefined || finalPrice === null) {
            return res.status(400).json({ success: false, error: 'finalPrice is required' });
        }

        const result = await simulationService.simulateRound(id, finalPrice);
        if (!result) {
            return res.status(404).json({ success: false, error: 'Round not found' });
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
    } catch (error) {
        next(error);
    }
});

// Hackathon mutation endpoints - with Zod validation
router.post('/hackathon/up-down/:id/bet', betRateLimiter, validate(upDownBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, side } = req.body;
    await getRepositories().rounds.placeBet(id, address, amount, side);
    sendSuccess(res, { message: 'Bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

router.post('/hackathon/precision/:id/bet', betRateLimiter, validate(precisionBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, predictedPrice } = req.body;
    await getRepositories().rounds.placeBet(id, address, amount, undefined, predictedPrice);
    sendSuccess(res, { message: 'Precision bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

export default router;
