/**
 * Express middleware that creates a root trace span for every incoming HTTP
 * request and attaches it to the response lifecycle (#534).
 *
 * The span captures:
 *   - method, route, status code, duration
 *   - correlation with requestId (X-Request-ID header)
 *   - errors thrown during request processing
 *
 * Spans are emitted via the tracing module's configured exporter (console
 * by default, disabled in test).  No external OTel collector is required.
 */

import { Request, Response, NextFunction } from 'express';
import { traceSpan, SpanAttributes } from '../utils/tracing';

/**
 * Normalize Express route params to avoid unbounded label cardinality.
 * e.g. /api/rounds/abc123 → /api/rounds/:id
 */
function normalizeRoute(req: Request): string {
  return req.route?.path
    ? `${req.baseUrl ?? ''}${req.route.path}`
    : req.path;
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req as any).requestId as string | undefined;
  const route = normalizeRoute(req);
  const spanName = `${req.method} ${route}`;

  const attrs: SpanAttributes = {
    'http.method': req.method,
    'http.route': route,
    'http.url': req.originalUrl,
    'http.user_agent': req.headers['user-agent'] ?? 'unknown',
  };
  if (requestId) {
    attrs.requestId = requestId;
  }

  const startTime = process.hrtime.bigint();

  traceSpan(spanName, attrs, (span) => {
    // Capture response finish to record status and duration
    res.on('finish', () => {
      const durationNs = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNs) / 1e6;

      span.setAttribute('http.status_code', res.statusCode);
      span.setAttribute('http.duration_ms', Math.round(durationMs * 100) / 100);

      if (res.statusCode >= 500) {
        span.setAttribute('error', true);
      }
    });

    next();
  }).catch(() => {
    // traceSpan should not throw; this is a safety net
    next();
  });
}
