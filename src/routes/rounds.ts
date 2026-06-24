import { Router } from 'express';
import { betRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain; this endpoint is logging/analytics only for now
router.post('/:id/bet', betRateLimiter, (_req, res) => {
  res.json({ success: true, message: 'Bet recorded (stub)' });
});

export default router;
