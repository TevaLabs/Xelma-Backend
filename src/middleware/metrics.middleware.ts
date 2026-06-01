import { Request, Response, NextFunction } from 'express';
import {
  httpErrorsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from '../metrics/application.metrics';

export * from '../metrics/application.metrics';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Normalizes dynamic Express route params so labels don't have unbounded
 * cardinality (e.g. /api/rounds/abc123 → /api/rounds/:id).
 */
function normalizeRoute(req: Request): string {
  return req.route?.path
    ? `${req.baseUrl ?? ''}${req.route.path}`
    : req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - startTime;
    const durationSeconds = Number(durationNs) / 1e9;

    const labels = {
      method: req.method,
      route: normalizeRoute(req),
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);

    if (res.statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }
  });

  next();
}
