import { Router, Request, Response } from 'express';
import predictionService from '../services/prediction.service';
import { authenticateUser } from '../middleware/auth.middleware';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/predictions/submit
 * Submits a prediction for a round (Authenticated users only)
 */
router.post('/submit', authenticateUser, async (req: Request, res: Response) => {
    try {
        const { roundId, userId, amount, side, priceRange } = req.body;

        // Validation
        if (!roundId) {
            return res.status(400).json({ error: 'Round ID is required' });
        }

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Either side or priceRange must be provided
        if (!side && !priceRange) {
            return res.status(400).json({ error: 'Either side (UP/DOWN) or priceRange must be provided' });
        }

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
 * GET /api/predictions/user/:userId
 * Gets all predictions for a user
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
 * GET /api/predictions/round/:roundId
 * Gets all predictions for a round
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
