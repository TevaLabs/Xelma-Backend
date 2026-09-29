import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { rateLimitMetricsService, RateLimitMetricsService } from '../services/rate-limit-metrics.service';
import { getRateLimitCategory } from '../security/rate-limit-endpoints';
import { rateLimitHitsTotal, rateLimitStoreFallbacksTotal } from './metrics.middleware';
import { RedisRateLimitStore, isRedisRateLimitConfigured } from '../lib/redis';
import logger from '../utils/logger';

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value.toLowerCase() !== 'false';
}

const REDIS_RATE_LIMIT_PREFIX =
  process.env.RATE_LIMIT_REDIS_PREFIX?.trim() || 'xelma:rl';
const REDIS_RATE_LIMIT_FAIL_OPEN = parseBooleanEnv(
  process.env.RATE_LIMIT_REDIS_FAIL_OPEN,
  true,
);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type RateLimitPolicy = {
  windowMs: number;
  max: number;
  message: string;
};

export const RATE_LIMIT_POLICIES = {
  api: {
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_API_MAX, 100),
    message: 'Too many requests from this IP. Please slow down and try again shortly.',
  },
  write: {
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WRITE_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_WRITE_MAX, 20),
    message: 'Too many write requests from this IP. Please wait before submitting again.',
  },
  bet: {
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_BET_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_BET_MAX, 5),
    message: 'Too many bet submissions from this IP. Please wait before placing another bet.',
  },
  predictionSubmit: {
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_PREDICTION_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.RATE_LIMIT_PREDICTION_MAX, 10),
    name: 'prediction/submit',
  },
  predictionBatchSubmit: {
    windowMs: parsePositiveInt(process.env.BATCH_PREDICTION_RATE_LIMIT_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.BATCH_PREDICTION_RATE_LIMIT_MAX, 3),
    name: 'prediction/batch-submit',
  },
  leaderboardBatch: {
    windowMs: parsePositiveInt(process.env.BATCH_LEADERBOARD_RATE_LIMIT_WINDOW_MS, 60 * 1000),
    max: parsePositiveInt(process.env.BATCH_LEADERBOARD_RATE_LIMIT_MAX, 10),
    name: 'leaderboard/batch',
  },
} as const;

function redisStoreFor(name: string) {
  if (!isRedisRateLimitConfigured()) return undefined;
  return new RedisRateLimitStore({
    prefix: `${REDIS_RATE_LIMIT_PREFIX}:${name}:`,
    failOpen: REDIS_RATE_LIMIT_FAIL_OPEN,
    onOutage: () => {
      rateLimitStoreFallbacksTotal.inc({ limiter: name });
    },
  });
}

function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  message: string;
  name: string;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}) {
  const store = redisStoreFor(opts.name);
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    message: {
      error: 'Too Many Requests',
      message: opts.message,
      retryAfter: Math.ceil(opts.windowMs / 1000),
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: opts.skip,
    ...(store ? { store } : {}),
    validate: { keyGeneratorIpFallback: false },
    handler: (req, res) => {
      const key = opts.keyGenerator ? opts.keyGenerator(req) : req.ip || 'unknown';
      const userId = (req as any).user?.userId;
      const category = getRateLimitCategory(opts.name);

      rateLimitHitsTotal.inc({ endpoint: opts.name, category });
      RateLimitMetricsService.recordHit(opts.name, req.method);

      rateLimitMetricsService.recordHit({
        endpoint: opts.name,
        key,
        ip: req.ip,
        userId,
      }).catch(err => logger.error(`Failed to record hit for ${opts.name}:`, err));

      res.status(429).json({
        error: 'Too Many Requests',
        message: opts.message,
        retryAfter: Math.ceil(opts.windowMs / 1000),
      });
    },
  });
}

// Baseline per-IP limit for all public `/api` traffic
export const apiRateLimiter = createRateLimiter({
  ...RATE_LIMIT_POLICIES.api,
  name: 'api/general',
});

// Stricter per-IP limit for mutation methods
export const writeRateLimiter = createRateLimiter({
  ...RATE_LIMIT_POLICIES.write,
  name: 'api/write',
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
});

// Strictest per-IP limit for bet submissions
export const betRateLimiter = createRateLimiter({
  ...RATE_LIMIT_POLICIES.bet,
  name: 'api/bet',
});

// Authentication endpoints
export const challengeRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many challenge requests from this IP, please try again after 15 minutes',
  name: 'auth/challenge',
});

export const connectRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
  name: 'auth/connect',
});

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  name: 'auth/general',
});

// Chat message rate limiter (per user)
export const chatMessageRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'You can only send 5 messages per minute. Please wait before sending another message.',
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  name: 'chat/message',
});

// Prediction submission rate limiter (per user)
export const predictionRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_POLICIES.predictionSubmit.windowMs,
  max: RATE_LIMIT_POLICIES.predictionSubmit.max,
  message: 'Too many prediction submissions. Please wait before submitting another.',
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  name: RATE_LIMIT_POLICIES.predictionSubmit.name,
});

// Stricter limit for batch prediction submission
export const batchPredictionRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_POLICIES.predictionBatchSubmit.windowMs,
  max: RATE_LIMIT_POLICIES.predictionBatchSubmit.max,
  message:
    'Too many batch prediction requests. Each batch can include many predictions — please wait before submitting another batch.',
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  name: RATE_LIMIT_POLICIES.predictionBatchSubmit.name,
});

// Rate limit for batch leaderboard lookups (per user)
export const batchLeaderboardRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_POLICIES.leaderboardBatch.windowMs,
  max: RATE_LIMIT_POLICIES.leaderboardBatch.max,
  message: 'Too many batch leaderboard requests. Please wait before trying again.',
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  name: RATE_LIMIT_POLICIES.leaderboardBatch.name,
});

// Admin round creation rate limiter (per IP)
export const adminRoundRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many round creation requests. Please wait before creating another round.',
  name: 'admin/round-create',
});

// Oracle round resolution rate limiter (per IP)
export const oracleResolveRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many resolve requests. Please wait before resolving another round.',
  name: 'oracle/round-resolve',
});
