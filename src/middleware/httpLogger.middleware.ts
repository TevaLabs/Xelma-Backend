import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/**
 * Structured HTTP request logging middleware.
 *
 * Logs a single `http request` entry on every response with consistent fields:
 *
 *   method, path, status, durationMs, requestId
 *
 * When an `Authorization` header is present, it is redacted to `[REDACTED]`
 * to prevent token leakage in log sinks (Issue #886).
 *
 * The log line is emitted on the response `finish` event so durationMs
 * reflects the full request lifecycle.
 */
export function httpLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startMs = Date.now();
  const path = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    const meta: Record<string, any> = {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
    };

    if (req.headers.authorization) {
      meta.authorization = '[REDACTED]';
    }

    logger.info('http request', meta);
  });

  next();
}
