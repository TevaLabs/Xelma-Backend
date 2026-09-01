import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getRequestContextStorage } from '../utils/requestContext';

/**
 * Middleware to generate or extract a unique request ID for tracing.
 * 
 * - Checks for X-Request-ID header in incoming request
 * - If not present, generates a new UUID
 * - Adds it to req.requestId
 * - Attaches it to response headers for client consumption
 * - Propagates requestId via AsyncLocalStorage so downstream services
 *   (Soroban, audit, outbox) can log it without explicit param threading
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
  next();
}
