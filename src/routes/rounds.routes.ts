import { Router, Request, Response } from 'express';
import roundService, { RoundServiceError } from '../services/round.service';
import resolutionService, { ResolutionServiceError } from '../services/resolution.service';
import sorobanService, { BlockchainError, BlockchainErrorType } from '../services/soroban.service';
import { requireAdmin, requireOracle } from '../middleware/auth.middleware';
import logger from '../utils/logger';

const router = Router();

/**
 * ENHANCED: Handle blockchain errors and convert to HTTP responses
 */
function handleBlockchainError(error: BlockchainError, res: Response): void {
  let statusCode = 500;

  switch (error.type) {
    case BlockchainErrorType.VALIDATION:
      statusCode = 400;
      break;
    case BlockchainErrorType.INSUFFICIENT_FUNDS:
      statusCode = 400;
      break;
    case BlockchainErrorType.CONTRACT_ERROR:
      statusCode = 400;
      break;
    case BlockchainErrorType.TIMEOUT:
      statusCode = 504;
      break;
    case BlockchainErrorType.TRANSIENT:
      statusCode = 503;
      break;
    case BlockchainErrorType.UNKNOWN:
    default:
      statusCode = 500;
  }

  logger.error('Blockchain error in rounds route', {
    errorType: error.type,
    message: error.message,
    retryable: error.retryable,
    txHash: error.txHash,
  });

  res.status(statusCode).json({
    error: error.type,
    message: error.message,
    retryable: error.retryable,
    txHash: error.txHash,
  });
}

/**
 * ENHANCED: Handle service errors with proper status codes
 */
function handleServiceError(error: any, res: Response, defaultMessage: string): void {
  if (error instanceof RoundServiceError || error instanceof ResolutionServiceError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof BlockchainError) {
    handleBlockchainError(error, res);
    return;
  }

  // Generic error
  res.status(500).json({
    error: 'Internal Server Error',
    message: error.message || defaultMessage,
  });
}
/**
 * ORIGINAL + ENHANCED: Start a new prediction round
 * Now includes blockchain error handling and 501 for LEGENDS mode
 * 
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
 *       409:
 *         description: Conflict (active round already exists)
 *         content:
 *           application/json:
 *             example: { error: "ACTIVE_ROUND_EXISTS", message: "An active round already exists" }
 *       501:
 *         description: LEGENDS mode not yet implemented
 *         content:
 *           application/json:
 *             example: { error: "LEGENDS_NOT_IMPLEMENTED", message: "LEGENDS mode is not yet supported by the smart contract" }
 *       503:
 *         description: Service unavailable (blockchain temporarily down)
 *         content:
 *           application/json:
 *             example: { error: "TRANSIENT", message: "Blockchain temporarily unavailable", retryable: true }
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
router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    try {
        const { mode, startPrice, duration } = req.body;

        // ORIGINAL: Validation
        if (mode === undefined || mode < 0 || mode > 1) {
            return res.status(400).json({ error: 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)' });
        }

        if (!startPrice || startPrice <= 0) {
            return res.status(400).json({ error: 'Invalid start price' });
        }

        if (!duration || duration <= 0) {
            return res.status(400).json({ error: 'Invalid duration' });
        }

        // ORIGINAL: Convert mode to game mode string
        const gameMode = mode === 0 ? 'UP_DOWN' : 'LEGENDS';
        
        // ENHANCED: Convert duration from seconds to minutes for service
        const durationMinutes = duration / 60;
        
        const round = await roundService.startRound(gameMode, startPrice, durationMinutes);

        // ORIGINAL: Return response
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
        
        // ENHANCED: Handle specific error types
        handleServiceError(error, res, 'Failed to start round');
    }
});

/**
 * ORIGINAL: Get a round by ID
 * 
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
        handleServiceError(error, res, 'Failed to get round');
    }
});

/**
 * ORIGINAL: Get active rounds
 * 
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
        handleServiceError(error, res, 'Failed to get active rounds');
    }
});

/**
 * ORIGINAL + ENHANCED: Resolve a round with the final price
 * Now includes blockchain error handling
 * 
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
 *       404:
 *         description: Round not found
 *         content:
 *           application/json:
 *             example: { error: "ROUND_NOT_FOUND", message: "Round not found" }
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
router.post('/:id/resolve', requireOracle, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { finalPrice } = req.body;

        // ORIGINAL: Validation
        if (!finalPrice || finalPrice <= 0) {
            return res.status(400).json({ error: 'Invalid final price' });
        }

        const round = await resolutionService.resolveRound(id, finalPrice);

        // ORIGINAL: Return response
        res.json({
            success: true,
            round: {
                id: round.id,
                status: round.status,
                startPrice: round.startPrice,
                endPrice: round.endPrice,
                predictions: round.predictions.length,
                winners: round.predictions.filter((p: any) => p.won === true).length,
            },
        });
    } catch (error: any) {
        logger.error('Failed to resolve round:', error);
        
        // ENHANCED: Handle specific error types
        handleServiceError(error, res, 'Failed to resolve round');
    }
});

/**
 * NEW: Get blockchain service status
 * Useful for health checks and monitoring
 * 
 * @swagger
 * /api/rounds/status/blockchain:
 *   get:
 *     summary: Get blockchain service status
 *     description: Returns the current status of the Soroban blockchain integration
 *     tags: [rounds]
 *     responses:
 *       200:
 *         description: Blockchain status
 *         content:
 *           application/json:
 *             example:
 *               initialized: true
 *               network: "testnet"
 *               contractId: "CABC...XYZ"
 *               status: "healthy"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get blockchain status" }
 */
/**
 * NEW: Get blockchain service status
 * Useful for health checks and monitoring
 * 
 * @swagger
 * /api/rounds/status/blockchain:
 *   get:
 *     summary: Get blockchain service status
 *     description: Returns the current status of the Soroban blockchain integration
 *     tags: [rounds]
 *     responses:
 *       200:
 *         description: Blockchain status
 *         content:
 *           application/json:
 *             example:
 *               initialized: true
 *               network: "testnet"
 *               contractId: "CABC...XYZ"
 *               status: "healthy"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get blockchain status" }
 */
router.get('/status/blockchain', async (req: Request, res: Response) => {
    try {
        const status = sorobanService.getStatus();
        
        res.json(status);
    } catch (error: any) {
        logger.error('Failed to get blockchain status:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: error.message || 'Failed to get blockchain status',
        });
    }
});

export default router;