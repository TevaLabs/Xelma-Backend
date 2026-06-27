import { Router, Request, Response, NextFunction } from 'express';
import { betRateLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate.middleware';
import { upDownBetSchema, precisionBetSchema } from '../schemas/bets.schema';
import config from '../config';
import roundService from '../services/round.service';
import hackathonService from '../services/hackathon.service';

const router = Router();

/**
 * @openapi
 * /api/rounds:
 *   get:
 *     summary: List mock prediction rounds
 *     tags:
 *       - rounds
 *     responses:
 *       200:
 *         description: Active and upcoming mock rounds
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (config.app.dataMode === 'mock') {
      const rounds = await hackathonService.getRounds();
      return res.json(rounds);
    }

    const { rounds, source } = await roundService.getActiveRoundsWithFallback();
    return res.json({ source, rounds });
  } catch (err) {
    next(err);
  }
});

// TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain; this endpoint is logging/analytics only for now
router.post('/:id/bet', betRateLimiter, (_req, res) => {
  res.json({ success: true, message: 'Bet recorded (stub)' });
});

// Hackathon mutation endpoints - with Zod validation for consistent error handling
router.post('/hackathon/up-down/:id/bet', betRateLimiter, validate(upDownBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, side } = req.body;
    await hackathonService.placeBet(id, address, amount, side);
    res.json({ success: true, message: 'Bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

router.post('/hackathon/precision/:id/bet', betRateLimiter, validate(precisionBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, predictedPrice } = req.body;
    await hackathonService.placeBet(id, address, amount, undefined, predictedPrice);
    res.json({ success: true, message: 'Precision bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

export default router;
