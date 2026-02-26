import { Router, Request, Response } from 'express';
import predictionService from '../services/prediction.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { predictionRateLimiter } from '../middleware/rateLimiter.middleware';
import { validate } from '../middleware/validate.middleware';
import { submitPredictionSchema } from '../schemas/predictions.schema';
import logger from '../utils/logger';

const router = Router();

/**
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
 *               amount: { type: number, minimum: 0 }
 *               side: { type: string, description: UP/DOWN (for UP_DOWN mode)" }
 *               priceRange: { type: string, description: Price range selection (for LEGENDS mode)" }
 *             required: [roundId, amount]
 *           example:
 *             roundId: "round-id"
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
 *               invalidAmount:
 *                 value: { error: "Invalid amount" }
 *               missingSideOrRange:
 *                 value: { error: "Either side (UP/DOWN) or priceRange must be provided" }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             example: { error: "No token provided" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             example: { error: "Too Many Requests", message: "Too many prediction submissions. Please wait before submitting another." }
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
 *             -d '{"roundId":"round-id","amount":10,"side":"UP"}'
 */
router.post('/submit', authenticateUser, predictionRateLimiter, validate(submitPredictionSchema), async (req: Request, res: Response) => {
    try {
        const { roundId, amount, side, priceRange } = req.body;
        const userId = req.user!.userId;

        const prediction = await predictionService.submitPrediction(
            userId,
            roundId,
            amount,
            side,
            priceRange
        );

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
        res.status(500).json({ error: error.message || 'Failed to submit prediction' });
    }
});

/**
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
