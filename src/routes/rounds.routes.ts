import { Router, Request, Response, NextFunction } from 'express';
import roundService from '../services/round.service';
import resolutionService from '../services/resolution.service';
import { requireAdmin, requireOracle, AuthenticatedRequest } from '../middleware/auth.middleware';
import { toDecimal, toDecimalString } from '../utils/decimal.util';
import { adminRoundRateLimiter, oracleResolveRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { startRoundSchema, resolveRoundSchema } from '../schemas/rounds.schema';
import { NotFoundError } from '../utils/errors';
import config from '../config';
import simulationService from '../services/simulation.service';

const router = Router();

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
 *                 description: Optional LEGENDS-only custom ranges; if omitted, default ranges are generated from startPrice.
 *                 items:
 *                   type: object
 *                   properties:
 *                     min: { type: number }
 *                     max: { type: number }
 *                   required: [min, max]
 *             required: [mode, startPrice, duration]
 *           example:
 *             mode: 1
 *             startPrice: 0.1234
 *             duration: 300
 *             priceRanges:
 *               - { min: 0.10, max: 0.12 }
 *               - { min: 0.12, max: 0.14 }
 *               - { min: 0.14, max: 0.16 }
 *     responses:
 *       200:
 *         description: Round started
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               round:
 *                 id: "round-id"
 *                 mode: "UP_DOWN"
 *                 status: "ACTIVE"
 *                 startTime: "2026-01-29T00:00:00.000Z"
 *                 endTime: "2026-01-29T00:05:00.000Z"
 *                 startPrice: 0.1234
 *                 sorobanRoundId: "1"
 *                 priceRanges: []
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized (missing/invalid token)
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden (admin role required)
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Conflict - active round already exists
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/RateLimitResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/rounds/start" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"mode":0,"startPrice":0.1234,"duration":300}'
 */
router.post('/start', requireAdmin, adminRoundRateLimiter, validate(startRoundSchema), (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
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
    } catch (error) {
        next(error);
    }
}) as any);

/**
 * @swagger
 * /api/rounds/active:
 *   get:
 *     summary: Get active rounds
 *     description: Returns the on-chain active round when Soroban is configured; falls back to database rounds when RPC is unavailable or ROUNDS_MOCK_MODE=true.
 *     tags: [rounds]
 *     responses:
 *       200:
 *         description: Active rounds
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               source: soroban
 *               rounds: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/rounds/active"
 */
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { source, rounds } = await roundService.getActiveRoundsWithFallback();

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
 *         description: Round ID
 *     responses:
 *       200:
 *         description: Round found
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               round: {}
 *       404:
 *         description: Round not found
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/rounds/round-id"
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

/**
 * @swagger
 * /api/rounds/{id}/resolve:
 *   post:
 *     summary: Resolve a round with the final price
 *     description: Oracle-only (or Admin). Resolves the round and computes winners. LEGENDS uses inclusive-lower/exclusive-upper range matching, with final range upper-bound inclusive.
 *     tags: [rounds]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Round ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               finalPrice: { type: number, description: Final price (must be > 0) }
 *             required: [finalPrice]
 *           example:
 *             finalPrice: 0.2345
 *     responses:
 *       200:
 *         description: Round resolved
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               round:
 *                 id: "round-id"
 *                 status: "RESOLVED"
 *                 startPrice: 0.1234
 *                 endPrice: 0.2345
 *                 resolvedAt: "2026-01-29T00:10:00.000Z"
 *                 predictions: 10
 *                 winners: 4
 *                 legendsPayoutRule: "winner payout = stake + (stake / winningPool) * losingPool"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden (oracle/admin required)
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/RateLimitResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             $ref: '#/components/schemas/ErrorResponse'
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/rounds/round-id/resolve" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"finalPrice":0.2345}'
 */
router.post('/:id/resolve', requireOracle, oracleResolveRateLimiter, validate(resolveRoundSchema), (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
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
    } catch (error) {
        next(error);
    }
}) as any);

/**
 * @swagger
 * /api/rounds/{id}/simulate:
 *   post:
 *     summary: Simulate a round resolution (Non-Production QA Endpoint)
 *     description: Simulates payout distribution for frontend QA without placing real bets or mutating the round status. Disabled in production unless ENABLE_SIMULATION=true.
 *     tags: [rounds]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Round ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               finalPrice: { type: number, description: Simulated final price }
 *             required: [finalPrice]
 *     responses:
 *       200:
 *         description: Simulation results showing winners, losers, and payout mock
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
            roundId: id,
            simulatedPrice: finalPrice,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

export default router;
