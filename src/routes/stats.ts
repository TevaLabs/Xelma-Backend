import { Request, Response, Router } from 'express';
import { platformStats } from '../data/mockData';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
   // TODO: Replace with live Stellar RPC queries via @stellar/stellar-sdk
   res.json(platformStats);
});

export default router;
