import rateLimit from 'express-rate-limit';
import { rateLimitMetricsService } from '../services/rate-limit-metrics.service';
import { getRateLimitCategory } from '../security/rate-limit-endpoints';
import { rateLimitHitsTotal } from './metrics.middleware';
import logger from '../utils/logger';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Documented limits for tests and operator reference */
export const RATE_LIMIT_POLICIES = {
  predictionSubmit: { windowMs: 60 * 1000, max: 10, name: 'prediction/submit' },
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

/**
 * Factory function to create rate limiters with consistent configuration
 */
function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  message: string;
  name: string;
  keyGenerator?: (req: any) => string;
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    keyGenerator: opts.keyGenerator,
    message: { error: 'Too Many Requests', message: opts.message },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const key = opts.keyGenerator ? opts.keyGenerator(req) : (req.ip || 'unknown');
      const userId = req.user?.userId;
      const category = getRateLimitCategory(opts.name);

      rateLimitHitsTotal.inc({ endpoint: opts.name, category });

      rateLimitMetricsService.recordHit({
        endpoint: opts.name,
        key: key,
        ip: req.ip,
        userId: userId,
      }).catch(err => logger.error(`Failed to record hit for ${opts.name}:`, err));

      res.status(429).json({ error: 'Too Many Requests', message: opts.message });
    },
  });
}

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

/**
 * Stricter limit for batch prediction submission (up to 50 predictions per request).
 * Tunable via BATCH_PREDICTION_RATE_LIMIT_MAX and BATCH_PREDICTION_RATE_LIMIT_WINDOW_MS.
 */
export const batchPredictionRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_POLICIES.predictionBatchSubmit.windowMs,
  max: RATE_LIMIT_POLICIES.predictionBatchSubmit.max,
  message:
    'Too many batch prediction requests. Each batch can include many predictions — please wait before submitting another batch.',
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  name: RATE_LIMIT_POLICIES.predictionBatchSubmit.name,
});

/**
 * Rate limit for batch leaderboard lookups (per user).
 */
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
