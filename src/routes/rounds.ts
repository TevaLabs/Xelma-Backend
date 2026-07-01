import { Router, Request, Response, NextFunction } from 'express';
import { betRateLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate.middleware';
import { betSchema, upDownBetSchema, precisionBetSchema } from '../schemas/bets.schema';
import { sendSuccess } from '../utils/response';

import { getRepositories } from '../repositories';
import config from '../config';
import sorobanService from '../services/soroban.service';
import { getMockRounds } from '../data/mockData';
import { mapSorobanActiveRound } from '../utils/soroban-round.mapper';
import logger from '../utils/logger';
const router = Router();

/**
 * @openapi
 * /api/rounds:
 *   get:
 *     summary: List active prediction rounds
 *     description: Returns on-chain active round when Soroban is configured; falls back to mock rounds when RPC is unavailable or ROUNDS_MOCK_MODE=true.
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
 *                   enum: [soroban, mock]
 *                 rounds:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!config.app.roundsMockMode) {
      try {
        const onChainRound = await sorobanService.getActiveRound();
        if (onChainRound) {
          const mapped = mapSorobanActiveRound(onChainRound);
          return res.json({ source: 'soroban', rounds: [mapped] });
        }
      } catch (err) {
        logger.warn('Soroban fetch failed; falling back to mock rounds', {
          error: (err as Error).message,
        });
      }
    }

    return res.json({ source: 'mock', rounds: getMockRounds() });
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
