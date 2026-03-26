import { Router, Request, Response } from 'express';
import { metricsRegistry } from '../middleware/metrics.middleware';

const router = Router();

/**
 * @openapi
 * /metrics:
 *   get:
 *     summary: Prometheus metrics
 *     description: >
 *       Returns all application and process metrics in Prometheus text format.
 *       Scrape this endpoint with a Prometheus instance.
 *     tags:
 *       - Observability
 *     responses:
 *       200:
 *         description: Prometheus text exposition format
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get('/', async (_req: Request, res: Response) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

export default router;
