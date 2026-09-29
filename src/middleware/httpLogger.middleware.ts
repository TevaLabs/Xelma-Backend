import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/**
 * Strip the query string from a URL, returning only the path segment.
 *
 * Used everywhere we log a URL so that tokens or secrets passed as query
 * parameters (e.g. `?access_token=…`, `?api_key=…`) never appear in logs.
 *
 * @example
 *   sanitizePath('/api/rounds?access_token=secret')  // → '/api/rounds'
 *   sanitizePath('/api/health')                       // → '/api/health'
 */
export function sanitizePath(url: string): string {
  return url.split('?')[0];
}

/**
 * Return the query-parameter keys from a URL without their values.
 *
 * Useful as a low-cardinality debugging hint: you can see *which* parameters
 * were supplied without revealing sensitive values.
 *
 * @example
 *   queryKeys('/api/rounds?access_token=secret&page=1')  // → ['access_token', 'page']
 *   queryKeys('/api/health')                              // → []
 */
export function queryKeys(url: string): string[] {
  const idx = url.indexOf('?');
  if (idx === -1) return [];
  const qs = url.slice(idx + 1);
  if (!qs) return [];
  return qs
    .split('&')
    .map((part) => part.split('=')[0])
    .filter(Boolean);
}

/**
 * Structured HTTP request logging middleware.
 *
 * Logs a single `http request` entry on every response with consistent fields:
 *
 *   method, path, status, durationMs, requestId[, queryKeys]
 *
 * - `path`      — the URL path only; the query string is intentionally omitted
 *                 to prevent tokens / secrets from leaking into logs.
 * - `queryKeys` — present only when query parameters exist; lists parameter
 *                 *names* (never values) so operators can see which params
 *                 were passed without exposing sensitive data.
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
  const path = sanitizePath(req.originalUrl);
  const keys = queryKeys(req.originalUrl);

  res.on('finish', () => {
    logger.info('http request', {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      // Only include when present — keeps log volume down for bare paths
      ...(keys.length > 0 && { queryKeys: keys }),
    });
  });

  next();
}
