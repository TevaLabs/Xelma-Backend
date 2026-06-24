import { Router } from 'express';
import { mockData } from '../data/mockData';

const router = Router();

router.get('/stats', (_req, res) => {
  res.json(mockData.platformStats);
});

export default router;
