import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { sanitizeHeaders } from '../utils/log-redaction.util';

/**
 * Structured HTTP request logging middleware.
 *
 * Logs a single `http request` entry on every response with consistent fields:
 *
 *   method, path, status, durationMs, requestId, headers
 *
 * The log line is emitted on the response `finish` event so durationMs
 * reflects the full request lifecycle.
 *
 * `headers` is a redacted copy of the request headers: Authorization, Cookie,
 * API-key and similar credential headers are logged as `[REDACTED]` (Issue
 * #886). `path` never includes the query string. `req.headers` itself is
 * never modified.
 */
export function httpLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startMs = Date.now();
  const path = req.originalUrl.split('?')[0];
  const headers = sanitizeHeaders(req.headers);

  res.on('finish', () => {
    logger.info('http request', {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      headers,
    });
  });

  next();
}
