import { Router, Request, Response } from 'express';
import { metricsRegistry } from '../middleware/metrics.middleware';
import { prisma } from '../lib/prisma';
import { checkSchemaReadiness } from '../services/schema-readiness.service';

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

/**
 * @openapi
 * /metrics/readiness:
 *   get:
 *     summary: Schema compatibility readiness check
 *     description: >
 *       Compares on-disk Prisma migrations against the migrations applied in
 *       the database. Returns 200 when the schema is compatible, 503 when
 *       migrations are pending or the database is unreachable.
 *     tags:
 *       - Observability
 *     responses:
 *       200:
 *         description: Schema is compatible and the service is ready.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: string
 *                   enum: [healthy, unreachable]
 *                 schema:
 *                   type: string
 *                   enum: [compatible, outdated, unknown]
 *                 appliedMigrations:
 *                   type: integer
 *                 totalMigrations:
 *                   type: integer
 *                 pendingMigrations:
 *                   type: integer
 *                 pendingNames:
 *                   type: array
 *                   items:
 *                     type: string
 *                 ready:
 *                   type: boolean
 *       503:
 *         description: Schema is outdated or database is unreachable.
 */
router.get('/readiness', async (_req: Request, res: Response) => {
  const payload = await checkSchemaReadiness(prisma as any);
  const statusCode = payload.ready ? 200 : 503;
  res.status(statusCode).json(payload);
});

export default router;
