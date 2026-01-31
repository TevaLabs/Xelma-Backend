import { Router, Request, Response } from 'express';
import predictionService from '../services/prediction.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { BlockchainError, BlockchainErrorType } from '../services/soroban.service';
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
    case BlockchainErrorType.UNKNOWN:
    default:
      statusCode = 500;
  }

  logger.error('Blockchain error in prediction submission', {
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
 * ORIGINAL + ENHANCED: Submit a prediction for a round
 * Now includes blockchain integration via x-signature header
 * 
 * @swagger
 * /api/predictions/submit:
 *   post:
 *     summary: Submit a prediction for a round
 *     description: Authenticated users only.
 *     tags: [predictions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               roundId: { type: string }
 *               userId: { type: string, description: User ID (currently required by the API body)" }
 *               amount: { type: number, minimum: 0 }
 *               side: { type: string, description: UP/DOWN (for UP_DOWN mode)" }
 *               priceRange: { type: string, description: Price range selection (for LEGENDS mode)" }
 *             required: [roundId, userId, amount]
 *           example:
 *             roundId: "round-id"
 *             userId: "user-id"
 *             amount: 10
 *             side: "UP"
 *     responses:
 *       200:
 *         description: Prediction submitted
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               prediction:
 *                 id: "prediction-id"
 *                 roundId: "round-id"
 *                 amount: 10
 *                 side: "UP"
 *                 priceRange: null
 *                 createdAt: "2026-01-29T00:00:00.000Z"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             examples:
 *               missingRoundId:
 *                 value: { error: "Round ID is required" }
 *               missingUserId:
 *                 value: { error: "User ID is required" }
 *               invalidAmount:
 *                 value: { error: "Invalid amount" }
 *               missingSideOrRange:
 *                 value: { error: "Either side (UP/DOWN) or priceRange must be provided" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to submit prediction" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/predictions/submit" \\
 *             -H "Content-Type: application/json" \\
 *             -H "Authorization: Bearer $TOKEN" \\
 *             -H "x-signature: $USER_SECRET_KEY" \\
 *             -d '{"roundId":"round-id","userId":"user-id","amount":10,"side":"UP"}'
 */
router.post('/submit', authenticateUser, async (req: Request, res: Response) => {
    try {
        const { roundId, userId, amount, side, priceRange } = req.body;

        // ORIGINAL: Validation
        if (!roundId) {
            return res.status(400).json({ error: 'Round ID is required' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // ORIGINAL: Either side or priceRange must be provided
        if (!side && !priceRange) {
            return res.status(400).json({ error: 'Either side (UP/DOWN) or priceRange must be provided' });
        }

        // ENHANCED: Extract user secret key from header (optional for blockchain integration)
        const userSecretKey = req.headers['x-signature'] as string | undefined;

        // ENHANCED: Call service with optional secret key for blockchain integration
        const prediction = await predictionService.submitPrediction(
            userId,
            roundId,
            amount,
            side,
            priceRange,
            userSecretKey  // NEW: Pass secret key for blockchain submission
        );

        // ORIGINAL: Return response
        res.json({
            success: true,
            prediction: {
                id: prediction.id,
                roundId: prediction.roundId,
                amount: prediction.amount,
                side: prediction.side,
                priceRange: prediction.priceRange,
                createdAt: prediction.createdAt,
            },
        });
    } catch (error: any) {
        logger.error('Failed to submit prediction:', error);

        // ENHANCED: Handle blockchain-specific errors
        if (error instanceof BlockchainError) {
            return handleBlockchainError(error, res);
        }

        // ENHANCED: Handle service errors with status codes
        if (error.statusCode) {
            return res.status(error.statusCode).json({
                error: error.code || 'Error',
                message: error.message,
            });
        }

        // ORIGINAL: Generic error handling
        res.status(500).json({ error: error.message || 'Failed to submit prediction' });
    }
});

/**
 * ORIGINAL: Get all predictions for a user
 * 
 * @swagger
 * /api/predictions/user/{userId}:
 *   get:
 *     summary: Get all predictions for a user
 *     tags: [predictions]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *         description: User ID
 *     responses:
 *       200:
 *         description: Predictions list
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               predictions: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get user predictions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/predictions/user/user-id"
 */
router.get('/user/:userId', async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        const predictions = await predictionService.getUserPredictions(userId);

        res.json({
            success: true,
            predictions,
        });
    } catch (error: any) {
        logger.error('Failed to get user predictions:', error);
        res.status(500).json({ error: error.message || 'Failed to get user predictions' });
    }
});

/**
 * ORIGINAL: Get all predictions for a round
 * 
 * @swagger
 * /api/predictions/round/{roundId}:
 *   get:
 *     summary: Get all predictions for a round
 *     tags: [predictions]
 *     parameters:
 *       - in: path
 *         name: roundId
 *         required: true
 *         schema: { type: string }
 *         description: Round ID
 *     responses:
 *       200:
 *         description: Predictions list
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               predictions: []
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example: { error: "Failed to get round predictions" }
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X GET "$API_BASE_URL/api/predictions/round/round-id"
 */
router.get('/round/:roundId', async (req: Request, res: Response) => {
    try {
        const { roundId } = req.params;

        const predictions = await predictionService.getRoundPredictions(roundId);

        res.json({
            success: true,
            predictions,
        });
    } catch (error: any) {
        logger.error('Failed to get round predictions:', error);
        res.status(500).json({ error: error.message || 'Failed to get round predictions' });
    }
});

export default router;