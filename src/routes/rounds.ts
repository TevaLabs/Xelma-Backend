import { Router, Request, Response, NextFunction } from 'express';
import { betRateLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate.middleware';
import { betSchema, upDownBetSchema, precisionBetSchema } from '../schemas/bets.schema';

import { getRepositories } from '../repositories';
import roundService from '../services/round.service';

const router = Router();

/**
 * @openapi
 * /api/rounds:
 *   get:
 *     summary: List active prediction rounds
 *     description: Returns on-chain active round when Soroban is configured; falls back to database rounds, then to mock data when chain is unavailable or ROUNDS_MOCK_MODE=true.
 *     tags:
 *       - rounds
 *     responses:
 *       200:
 *         description: Active rounds with source metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 source:
 *                   type: string
 *                   enum: [soroban, database, mock]
 *                 rounds:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { source, rounds } = await roundService.getRoundsForApi();
    return res.json({ source, rounds });
  } catch (err) {
    next(err);
  }
});

// TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain; this endpoint is logging/analytics only for now
router.post('/:id/bet', betRateLimiter, validate(betSchema), (_req, res) => {
  res.json({ success: true, message: 'Bet recorded (stub)' });
});

// Hackathon mutation endpoints - with Zod validation for consistent error handling
router.post('/hackathon/up-down/:id/bet', betRateLimiter, validate(upDownBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, side } = req.body;
    await getRepositories().rounds.placeBet(id, address, amount, side);
    res.json({ success: true, message: 'Bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

router.post('/hackathon/precision/:id/bet', betRateLimiter, validate(precisionBetSchema), (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { address, amount, predictedPrice } = req.body;
    await getRepositories().rounds.placeBet(id, address, amount, undefined, predictedPrice);
    res.json({ success: true, message: 'Precision bet recorded (stub)' });
  } catch (err) {
    next(err);
  }
}) as any);

export default router;
