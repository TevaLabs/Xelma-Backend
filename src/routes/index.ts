import { Router } from 'express';
import { getPrices } from '../services/priceService';

const router = Router();

router.get('/prices', async (req, res) => {
  const prices = await getPrices();
  res.json(prices);
});

export default router;