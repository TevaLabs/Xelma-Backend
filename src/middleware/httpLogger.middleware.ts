import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { redact, redactField } from '../utils/log-redaction';

/**
 * Structured HTTP request logging middleware.
 *
 * Logs a single `http request` entry on every response with consistent fields:
 *
 *   method, path, status, durationMs, requestId, headers, body
 *
 * The log line is emitted on the response `finish` event so durationMs
 * reflects the full request lifecycle.
 *
 * Everything logged here goes through the central redactor
 * (src/utils/log-redaction.ts): `Authorization`, cookies and API keys are
 * never logged as values, selected body fields are key-redacted, and wallet
 * addresses embedded in the path are truncated to `GABC…WXYZ` form — shared
 * Render logs must not leak auth headers or full addresses.
 */

/** Debug-useful headers worth logging; everything else is not captured. */
const LOGGED_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'x-request-id',
  'idempotency-key',
  'x-api-key',
  'cookie',
] as const;

/** Selected request-body fields worth correlating; wallets are truncated. */
const LOGGED_BODY_FIELDS = [
  'address',
  'walletAddress',
  'wallet',
  'publicKey',
  'userId',
  'roundId',
  'side',
  'amount',
  'predictedPrice',
] as const;

function pickLoggedHeaders(headers: Request['headers']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of LOGGED_HEADERS) {
    const value = headers[name];
    if (value !== undefined) {
      out[name] = redactField(name, value);
    }
  }
  return out;
}

function pickLoggedBody(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of LOGGED_BODY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, name)) {
      out[name] = redactField(name, source[name]);
    }
  }
  return out;
}

export function httpLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startMs = Date.now();
  const path = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    logger.info('http request', {
      requestId: req.requestId,
      method: req.method,
      path: redact(path),
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      headers: pickLoggedHeaders(req.headers),
      body: pickLoggedBody(req.body),
    });
  });

  next();
}
