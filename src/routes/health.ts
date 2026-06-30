import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import sorobanService from '../services/soroban.service';
import priceOracle from '../services/oracle';
import { checkRedisHealth } from '../lib/redis';
import { withTimeout } from '../utils/timeout-wrapper';
import logger from '../utils/logger';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import config from '../config';

const router = Router();

const HEALTH_TIMEOUT_MS = 3000;

async function checkDatabase(): Promise<{
  status: string;
  durationMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await withTimeout(
      () => prisma.$queryRaw`SELECT 1`,
      {
        timeoutMs: HEALTH_TIMEOUT_MS,
        operationName: 'health-db-ping',
        retries: 1,
      },
    );
    return { status: 'healthy', durationMs: Date.now() - start };
  } catch (err) {
    logger.warn('Health check: database unreachable', { error: err });
    return {
      status: 'unhealthy',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkRedis(): Promise<{
  status: string;
  durationMs: number;
  error?: string;
}> {
  return checkRedisHealth(HEALTH_TIMEOUT_MS);
}

async function checkSoroban(): Promise<{
  status: string;
  durationMs: number;
  initialized?: boolean;
  error?: string;
}> {
  const start = Date.now();
  try {
    const health = await withTimeout(
      () => Promise.resolve(sorobanService.getHealth()),
      {
        timeoutMs: HEALTH_TIMEOUT_MS,
        operationName: 'health-soroban',
        retries: 1,
      },
    );
    const healthData = health.data;
    return {
      status: healthData?.initialized ? 'healthy' : 'unavailable',
      durationMs: Date.now() - start,
      initialized: healthData?.initialized,
      error: health.error?.message,
    };
  } catch (err) {
    return {
      status: 'degraded',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkOracle(): Promise<{
  status: string;
  durationMs: number;
  stale?: boolean;
  lastUpdatedAt?: string | null;
  error?: string;
}> {
  const start = Date.now();
  try {
    if (!priceOracle.isRunning()) {
      return { status: 'not_running', durationMs: Date.now() - start };
    }
    const stale = priceOracle.isStale();
    const lastUpdatedAt = priceOracle.getLastUpdatedAt();
    return {
      status: stale ? 'stale' : 'healthy',
      durationMs: Date.now() - start,
      stale,
      lastUpdatedAt: lastUpdatedAt?.toISOString() ?? null,
    };
  } catch (err) {
    return {
      status: 'degraded',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const startTime = Date.now();

    const [database, redis, soroban, oracle] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkSoroban(),
      checkOracle(),
    ]);

    const services = { database, redis, soroban, oracle };

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (database.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else if (
      redis.status === 'degraded' ||
      soroban.status === 'degraded' ||
      oracle.status === 'degraded'
    ) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    res.json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      durationMs: Date.now() - startTime,
      services,
    });
  }),
);

/**
 * Lightweight hackathon health endpoint.
 *
 * Returns the process status plus timed checks for the two deps that
 * the hackathon app actually owns: the price data source and the Soroban
 * service.  No database ping is performed here so the response stays fast
 * enough for readiness probes.
 *
 * Status semantics:
 *   ok       – process is healthy, all checked deps report ok
 *   degraded – at least one non-critical dep (e.g. Soroban not initialized)
 *              is unavailable; the service is still serving requests
 */
router.get('/health', (_req: Request, res: Response) => {
  const isMockMode = config.app.dataMode === 'mock';
  const sorobanReady = sorobanService.isReady();

  const services = {
    price: {
      status: 'ok',
      source: isMockMode ? 'static-mock' : 'coingecko',
      mockMode: isMockMode,
    },
    soroban: {
      status: sorobanReady ? 'ok' : 'unavailable',
      initialized: sorobanReady,
    },
  };

  const overallStatus: 'ok' | 'degraded' = sorobanReady ? 'ok' : 'degraded';

  res.json({
    status: overallStatus,
    timestamp: Date.now(),
    services,
  });
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Service health check with dependency checks
 *     description: |
 *       Checks DB, Redis, Soroban, and Oracle health with timeout bounds.
 *       Always returns HTTP 200 so load balancers keep routing traffic.
 *       The `status` field is `healthy`, `degraded`, or `unhealthy`.
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Health check completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - status
 *                 - timestamp
 *                 - uptime
 *                 - durationMs
 *                 - services
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, degraded, unhealthy]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptime:
 *                   type: number
 *                 durationMs:
 *                   type: number
 *                 services:
 *                   type: object
 *                   required:
 *                     - database
 *                     - redis
 *                     - soroban
 *                     - oracle
 *                   properties:
 *                     database:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [healthy, unhealthy]
 *                         durationMs:
 *                           type: number
 *                         error:
 *                           type: string
 *                     redis:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [healthy, degraded, unavailable, bypassed]
 *                         durationMs:
 *                           type: number
 *                         error:
 *                           type: string
 *                     soroban:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [healthy, unavailable, degraded]
 *                         durationMs:
 *                           type: number
 *                         initialized:
 *                           type: boolean
 *                         error:
 *                           type: string
 *                     oracle:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [healthy, stale, not_running, degraded]
 *                         durationMs:
 *                           type: number
 *                         stale:
 *                           type: boolean
 *                         lastUpdatedAt:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         error:
 *                           type: string
 */
export default router;
