import { Router } from 'express';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

export default router;
