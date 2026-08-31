import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import sorobanService from '../services/soroban.service';
import priceOracle from '../services/oracle';
import { checkRedisHealth, isRedisCacheEnabled } from '../lib/redis';
import { withTimeout } from '../utils/timeout-wrapper';
import logger from '../utils/logger';
import { asyncHandler } from '../middleware/errorHandler.middleware';
import { sendSuccess } from '../utils/response';
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
    const result = await withTimeout(
      () => prisma.$queryRaw`SELECT 1`,
      {
        timeoutMs: HEALTH_TIMEOUT_MS,
        operationName: 'health-db-ping',
        retries: 1,
      },
    );
    if (!result.success) {
      logger.warn('Health check: database unreachable', {
        error: result.error,
      });
      return {
        status: 'unhealthy',
        durationMs: Date.now() - start,
        error: result.error?.message,
      };
    }
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
      status: health.data?.initialized ? 'healthy' : 'unavailable',
      durationMs: Date.now() - start,
      initialized: health.data?.initialized,
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
  stalenessSeconds?: number | null;
  provider?: string | null;
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
      stalenessSeconds: priceOracle.getStalenessSeconds(),
      provider: priceOracle.getActiveSource(),
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
      oracle.status === 'degraded' ||
      oracle.status === 'stale'
    ) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    sendSuccess(res, {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      durationMs: Date.now() - startTime,
      services,
    });
  }),
);

function isDatabaseConfigured(): boolean {
  // The DB is a configured dependency when the app runs in postgres mode
  // (i.e. DATA_STORE=postgres, which is the default for live mode).
  return config.app.dataStore === 'postgres';
}

function isRedisConfigured(): boolean {
  // Redis is configured when REDIS_URL is present and cache is not explicitly
  // disabled.  isRedisCacheEnabled() returns false both when REDIS_URL is
  // absent and when REDIS_CACHE_ENABLED=false.
  return isRedisCacheEnabled();
}

/**
 * Lightweight hackathon health endpoint.
 *
 * Returns the process status plus timed checks for deps that the hackathon
 * app actually owns: the price data source, the Soroban service, and — when
 * configured — the database and Redis cache.
 *
 * Unconfigured dependencies are omitted from the response entirely so the
 * health payload stays small and accurate.
 *
 * Status semantics:
 *   ok       – process is healthy, all checked deps report ok
 *   degraded – at least one non-critical dep (e.g. Soroban not initialized,
 *              database ping failed, Redis unreachable) is unavailable;
 *              the service is still serving requests
 */
router.get('/health', asyncHandler(async (_req: Request, res: Response) => {
  const startTime = Date.now();
  const isMockMode = config.app.dataMode === 'mock';
  const sorobanReady = sorobanService.isReady();

  const services: Record<string, unknown> = {
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

  let degraded = !sorobanReady;

  // Run optional dependency probes in parallel so the response stays fast.
  const probes: Array<Promise<void>> = [];

  if (isDatabaseConfigured()) {
    probes.push(
      checkDatabase().then((result) => {
        services.database = result;
        if (result.status !== 'healthy') {
          degraded = true;
        }
      }),
    );
  }

  if (isRedisConfigured()) {
    probes.push(
      checkRedis().then((result) => {
        services.redis = result;
        if (result.status !== 'healthy' && result.status !== 'bypassed') {
          degraded = true;
        }
      }),
    );
  }

  await Promise.all(probes);

  const overallStatus: 'ok' | 'degraded' = degraded ? 'degraded' : 'ok';

  sendSuccess(res, {
    status: overallStatus,
    timestamp: Date.now(),
    durationMs: Date.now() - startTime,
    services,
  });
}));

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
 *                         stalenessSeconds:
 *                           type: integer
 *                           nullable: true
 *                           description: Age of the current price in seconds; null if never fetched.
 *                         provider:
 *                           type: string
 *                           nullable: true
 *                           description: Provider that supplied the current price (e.g. coingecko).
 *                         error:
 *                           type: string
 *
 * /api/health:
 *   get:
 *     summary: Lightweight hackathon health check
 *     tags:
 *       - health
 *     responses:
 *       200:
 *         description: Process and dependency status
 */
export default router;
