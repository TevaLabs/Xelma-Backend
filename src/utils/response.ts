import { Response } from 'express';

export function sendSuccess<T>(
  res: Response,
  data: T,
  meta?: Record<string, unknown>,
  statusCode: number = 200
): Response {
  const body: { success: true; data: T; meta?: Record<string, unknown> } = {
    success: true,
    data,
  };
  if (meta !== undefined) {
    body.meta = meta;
  }
  return res.status(statusCode).json(body);
}

export function sendError(
  res: Response,
  error: string,
  statusCode: number = 500
): Response {
  return res.status(statusCode).json({ success: false, error });
}

export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * Standard error envelope shared by every API failure response.
 *
 * The shape is part of the public contract (see the OpenAPI `ErrorResponse`
 * schema):
 *   - `error`    — the error class name (`ValidationError`, `AuthenticationError`, …)
 *   - `message`  — the human-readable description
 *   - `code`     — the stable machine-readable error code
 *   - `path`     — the request path the failure belongs to
 *   - `requestId`— the correlation id, when the request-id middleware ran
 *   - `timestamp`— ISO-8601 emission time
 */
export interface StandardErrorBody {
  error: string;
  message: string;
  code: string;
  path: string;
  requestId?: string;
  timestamp: string;
  details?: ErrorDetail[];
}

export function buildStandardErrorBody(params: {
  error: string;
  message: string;
  code: string;
  path: string;
  requestId?: string;
  details?: ErrorDetail[];
  timestamp?: string;
}): StandardErrorBody {
  const body: StandardErrorBody = {
    error: params.error,
    message: params.message,
    code: params.code,
    path: params.path,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };

  if (params.requestId) {
    body.requestId = params.requestId;
  }

  if (params.details && params.details.length > 0) {
    body.details = params.details;
  }

  return body;
}
