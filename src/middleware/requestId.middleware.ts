import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getRequestContextStorage } from '../utils/requestContext';
import { enterSpan, finishSpan, startSpan } from '../observability/tracing';

/**
 * Middleware to generate or extract a unique request ID for tracing.
 *
 * - Checks for X-Request-ID header in incoming request
 * - If not present, generates a new UUID
 * - Adds it to req.requestId
 * - Attaches it to response headers for client consumption
 * - Propagates requestId via AsyncLocalStorage so downstream services
 *   (Soroban, audit, outbox) can log it without explicit param threading
 * - Opens the root trace span for the request (#630); nested spans created by
 *   services (Prisma/Soroban/bet paths) become children of it automatically.
 *   No-op unless tracing is enabled — see src/observability/tracing.ts.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Check for existing request ID in headers (e.g., from upstream service)
  const incomingRequestId = req.headers['x-request-id'] as string;

  // Use incoming request ID if available, otherwise generate a new one
  const requestId = incomingRequestId || randomUUID();

  // Attach to request object for use in handlers and services
  (req as any).requestId = requestId;

  // Set response header so client can correlate
  res.set('X-Request-ID', requestId);

  // Propagate via AsyncLocalStorage for distributed tracing
  getRequestContextStorage().enterWith({ requestId });

  // Root span. `startSpan` returns a no-op span when tracing is disabled, and
  // `enterSpan` ignores no-op spans, so there is no overhead in the default path.
  const span = startSpan('http.server.request', {
    requestId,
    'http.method': req.method,
    'http.url': req.originalUrl,
    'http.route': req.path,
  });
  enterSpan(span);

  res.on('finish', () => {
    span.setAttribute('http.status_code', res.statusCode);
    if (res.statusCode >= 500) {
      span.recordError(new Error(`HTTP ${res.statusCode} ${req.method} ${req.path}`));
    }
    finishSpan(span);
  });

  next();
}
