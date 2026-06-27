import { Router } from 'express';

const router = Router();

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: API health check
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

export default router;
