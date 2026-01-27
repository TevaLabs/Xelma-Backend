import { Router, Request, Response } from 'express';
import roundService from '../services/round.service';
import resolutionService from '../services/resolution.service';
import { requireAdmin, requireOracle } from '../middleware/auth.middleware';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/rounds/start
 * Starts a new prediction round (Admin only)
 */
router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    try {
        const { mode, startPrice, duration } = req.body;

        // Validation
        if (!mode || mode < 0 || mode > 1) {
            return res.status(400).json({ error: 'Invalid mode. Must be 0 (UP_DOWN) or 1 (LEGENDS)' });
        }

        if (!startPrice || startPrice <= 0) {
            return res.status(400).json({ error: 'Invalid start price' });
        }

        if (!duration || duration <= 0) {
            return res.status(400).json({ error: 'Invalid duration' });
        }

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
        res.status(500).json({ error: error.message || 'Failed to start round' });
    }
});

/**
 * GET /api/rounds/:id
 * Gets a specific round by ID
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
 * GET /api/rounds/active
 * Gets all active rounds
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
 * POST /api/rounds/:id/resolve
 * Resolves a round with the final price (Oracle only)
 */
router.post('/:id/resolve', requireOracle, async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { finalPrice } = req.body;

        if (!finalPrice || finalPrice <= 0) {
            return res.status(400).json({ error: 'Invalid final price' });
        }

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
