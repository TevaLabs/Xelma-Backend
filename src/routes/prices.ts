import { Router, Request, Response } from 'express';
import { getPrices } from '../services/priceService';

const router = Router();

router.get('/prices', async (_req: Request, res: Response) => {
  try {
    const snapshot = await getPrices();
    res.json(snapshot);
  } catch (error) {
    res.status(503).json({
      error: 'Price service unavailable',
      message:
        error instanceof Error
          ? error.message
          : 'Unable to fetch prices and no cached data is available',
      stale: true,
      lastUpdatedAt: null,
      source: null,
    });
  }
});

export default router;
