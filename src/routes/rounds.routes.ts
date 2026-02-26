import { Router, Request, Response } from 'express';
import roundService from '../services/round.service';
import resolutionService from '../services/resolution.service';
import { requireAdmin, requireOracle } from '../middleware/auth.middleware';
import { adminRoundRateLimiter, oracleResolveRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { startRoundSchema, resolveRoundSchema } from '../schemas/rounds.schema';
import logger from '../utils/logger';

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
 *             required: [mode, startPrice, duration]
 *           example:
 *             mode: 0
 *             startPrice: 0.1234
 *             duration: 300
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
 *             examples:
 *               invalidMode:
 *                 value: { error: "Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)" }
 *               invalidStartPrice:
 *                 value: { error: "Invalid start price" }
 *               invalidDuration:
 *                 value: { error: "Invalid duration" }
 *       401:
 *         description: Unauthorized (missing/invalid token)
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       403:
 *         description: Forbidden (admin role required)
 *         content:
 *           application/json:
 *             example: { error: "Admin access required" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             example: { error: "Too Many Requests", message: "Too many round creation requests. Please wait before creating another round." }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to start round" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/rounds/start" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"mode":0,"startPrice":0.1234,"duration":300}'
 */
router.post('/start', requireAdmin, adminRoundRateLimiter, validate(startRoundSchema), async (req: Request, res: Response) => {
    try {
        const { mode, startPrice, duration } = req.body;
        const gameMode = mode === 0 ? 'UP_DOWN' : 'LEGENDS';
        const round = await roundService.startRound(gameMode, startPrice, duration);

        res.json({
            success: true,
            round: {
                id: round.id,
                mode: round.mode,
                status: round.status,
                startTime: round.startTime,
                endTime: round.endTime,
                startPrice: round.startPrice,
                sorobanRoundId: round.sorobanRoundId,
                priceRanges: round.priceRanges,
            },
        });
    } catch (error: any) {
        logger.error('Failed to start round:', error);
        
        // Return 409 Conflict if active round already exists
        if (error.code === 'ACTIVE_ROUND_EXISTS') {
            return res.status(409).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message || 'Failed to start round' });
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
 *             example: { error: "Round not found" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get round" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/rounds/round-id"
 */
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const round = await roundService.getRound(id);

        if (!round) {
            return res.status(404).json({ error: 'Round not found' });
        }

        res.json({
            success: true,
            round,
        });
    } catch (error: any) {
        logger.error('Failed to get round:', error);
        res.status(500).json({ error: error.message || 'Failed to get round' });
    }
});

/**
 * @swagger
 * /api/rounds/active:
 *   get:
 *     summary: Get active rounds
 *     tags: [rounds]
 *     responses:
 *       200:
 *         description: Active rounds
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               rounds: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get active rounds" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/rounds/active"
 */
router.get('/active', async (req: Request, res: Response) => {
    try {
        const rounds = await roundService.getActiveRounds();

        res.json({
            success: true,
            rounds,
        });
    } catch (error: any) {
        logger.error('Failed to get active rounds:', error);
        res.status(500).json({ error: error.message || 'Failed to get active rounds' });
    }
});

/**
 * @swagger
 * /api/rounds/{id}/resolve:
 *   post:
 *     summary: Resolve a round with the final price
 *     description: Oracle-only (or Admin). Resolves the round and computes winners.
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
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             example: { error: "Invalid final price" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       403:
 *         description: Forbidden (oracle/admin required)
 *         content:
 *           application/json:
 *             example: { error: "Oracle or Admin access required" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             example: { error: "Too Many Requests", message: "Too many resolve requests. Please wait before resolving another round." }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to resolve round" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/rounds/round-id/resolve" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -d '{"finalPrice":0.2345}'
 */
router.post('/:id/resolve', requireOracle, oracleResolveRateLimiter, validate(resolveRoundSchema), async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { finalPrice } = req.body;

        const round = await resolutionService.resolveRound(id, finalPrice);

        res.json({
            success: true,
            round: {
                id: round.id,
                status: round.status,
                startPrice: round.startPrice,
                endPrice: round.endPrice,
                resolvedAt: round.resolvedAt,
                predictions: round.predictions.length,
                winners: round.predictions.filter((p: any) => p.won === true).length,
            },
        });
    } catch (error: any) {
        logger.error('Failed to resolve round:', error);
        res.status(500).json({ error: error.message || 'Failed to resolve round' });
    }
});

export default router;
