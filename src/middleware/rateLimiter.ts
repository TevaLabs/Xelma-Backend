import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { RateLimitMetricsService } from '../services/rate-limit-metrics.service';

type RateLimitPolicy = {
  windowMs: number;
  max: number;
  message: string;
};

/** Documented limits for operators and README */
export const RATE_LIMIT_POLICIES = {
  api: {
    windowMs: 60 * 1000,
    max: 100,
    message:
      'Too many requests from this IP. Please slow down and try again shortly.',
  },
  write: {
    windowMs: 60 * 1000,
    max: 20,
    message:
      'Too many write requests from this IP. Please wait before submitting again.',
  },
  bet: {
    windowMs: 60 * 1000,
    max: 5,
    message:
      'Too many bet submissions from this IP. Please wait before placing another bet.',
  },
} as const satisfies Record<string, RateLimitPolicy>;

function createRateLimiter(policy: RateLimitPolicy, skip?: (req: Request) => boolean) {
  return rateLimit({
    windowMs: policy.windowMs,
    max: policy.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    handler: (req: Request, res: Response) => {
      const endpoint = req.baseUrl + req.path;
      RateLimitMetricsService.recordHit(endpoint, req.method);

      res.status(429).json({
        error: 'Too Many Requests',
        message: policy.message,
        retryAfter: Math.ceil(policy.windowMs / 1000),
      });
    },
  });
}

/** Baseline per-IP limit for all public `/api` traffic */
export const apiRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.api);

/** Stricter per-IP limit for mutation methods */
export const writeRateLimiter = createRateLimiter(
  RATE_LIMIT_POLICIES.write,
  (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
);

/** Strictest per-IP limit for bet submissions */
export const betRateLimiter = createRateLimiter(RATE_LIMIT_POLICIES.bet);
