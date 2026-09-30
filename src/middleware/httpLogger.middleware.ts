import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { getTraceContext } from '../observability/tracing';

/**
 * Structured HTTP request logging middleware.
 *
 * Logs a single `http request` entry on every response with consistent fields:
 *
 *   method, path, status, durationMs, requestId, traceId, spanId
 *
 * `traceId`/`spanId` are present only when tracing is enabled, and correlate
 * this log line with the spans created for the same request (#630). The log
 * line is emitted on the response `finish` event so durationMs reflects the
 * full request lifecycle.
 */
export function httpLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startMs = Date.now();
  const path = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    const { traceId, spanId } = getTraceContext();
    logger.info('http request', {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      ...(traceId ? { traceId, spanId } : {}),
    });
  });

  next();
}
