import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for authentication endpoints
 * Prevents brute force attacks and abuse
 *
 * Limits:
 * - 10 requests per 15 minutes per IP for challenge endpoint
 * - 5 requests per 15 minutes per IP for connect endpoint
 */

// Rate limiter for /api/auth/challenge
export const challengeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: 'Too Many Requests',
    message: 'Too many challenge requests from this IP, please try again after 15 minutes',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many challenge requests from this IP, please try again after 15 minutes',
    });
  },
});

// Rate limiter for /api/auth/connect
export const connectRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs (stricter for actual authentication)
  message: {
    error: 'Too Many Requests',
    message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
    });
  },
});

// General rate limiter for all auth routes (fallback)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs
  message: {
    error: 'Too Many Requests',
    message: 'Too many requests from this IP, please try again after 15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many requests from this IP, please try again after 15 minutes',
    });
  },
});

/**
 * Rate limiter for chat messages
 * Limits: 5 messages per minute per USER (not per IP)
 *
 * NOTE: This requires authenticateUser middleware to run first
 * to populate req.user.userId
 */
export const chatMessageRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 messages per minute per user
  keyGenerator: (req) => {
    // Use userId for rate limiting (requires authentication first)
    // Falls back to IP if userId not available
    return (req as any).user?.userId || req.ip || 'unknown';
  },
  message: {
    error: 'Too Many Messages',
    message: 'You can only send 5 messages per minute. Please wait before sending another message.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too Many Messages',
      message: 'You can only send 5 messages per minute. Please wait before sending another message.',
    });
  },
});
