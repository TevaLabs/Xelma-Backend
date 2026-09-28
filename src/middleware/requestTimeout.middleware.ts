import { NextFunction, Request, Response } from 'express';

const HEALTH_PATHS = new Set(['/health', '/api/health', '/api', '/api/']);

/**
 * Ends requests that exceed the server-side deadline. The response uses the
 * same error envelope as the full application's centralized error handler.
 * Health probes are excluded so their own dependency-check timeouts control
 * their response instead.
 */
export function requestTimeoutMiddleware(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (HEALTH_PATHS.has(req.path)) {
      next();
      return;
    }

    const clearTimer = () => clearTimeout(timer);
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;

      // Do not let a request whose handler timed out occupy a keep-alive
      // connection after the deadline response has been sent.
      res.setHeader('Connection', 'close');
      res.shouldKeepAlive = false;
      res.status(504).json({
        error: 'Request timed out',
        message: 'Request timed out',
        code: 'REQUEST_TIMEOUT',
        path: req.originalUrl,
        requestId: (req as Request & { requestId?: string }).requestId,
        timestamp: new Date().toISOString(),
      });
    }, timeoutMs);

    res.once('finish', clearTimer);
    res.once('close', clearTimer);
    req.once('aborted', clearTimer);
    next();
  };
}