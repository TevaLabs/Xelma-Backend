import { Request, Response, Router } from 'express';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
   res.json({
      status: 'ok',
      timestamp: Date.now(),
   });
});

export default router;
