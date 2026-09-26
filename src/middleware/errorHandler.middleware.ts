import { Request, Response, NextFunction } from 'express';
import {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
} from '@prisma/client/runtime/library';
import { AppError, BackpressureError, ValidationError, ErrorCode } from '../utils/errors';
import { CircuitBreakerOpenError } from '../utils/circuit-breaker';
import logger from '../utils/logger';

/**
 * Standardized error response shape.
 * All error responses from this API follow this contract.
 */
export interface ErrorResponse {
  error: string;
  message: string;
  code: string;
  path: string; // <-- Added to satisfy the explicit issue requirement
  requestId?: string;
  details?: { field: string; message: string }[];
  timestamp?: string;
  retryAfter?: number;
}

/**
 * Maps a Prisma known-request error to an AppError.
 */
function fromPrismaError(err: PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2025':
      // Record not found
      return new AppError(
        (err.meta?.cause as string | undefined) ?? 'Record not found',
        404,
        ErrorCode.NOT_FOUND,
      );
    case 'P2002': {
      const fields = Array.isArray(err.meta?.target)
        ? (err.meta!.target as string[]).join(', ')
        : 'field';
      return new AppError(`Unique constraint failed on: ${fields}`, 409, ErrorCode.CONFLICT);
    }
    case 'P2003':
      return new AppError('Related record not found', 400, 'FOREIGN_KEY_VIOLATION');
    default:
      return new AppError('Database error', 500, ErrorCode.INTERNAL_SERVER_ERROR);
  }
}

/**
 * Central Express error-handling middleware.
 *
 * Register this LAST in src/index.ts or src/app.ts so it catches errors forwarded
 * via `next(error)` from any route or middleware.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  let appError: AppError;

  let retryAfterSeconds: number | undefined;

  if (err instanceof BackpressureError) {
    appError = err;
    retryAfterSeconds = err.retryAfterSeconds;
  } else if (err instanceof CircuitBreakerOpenError) {
    appError = new AppError(
      'Contract service temporarily unavailable. Please retry shortly.',
      503,
      ErrorCode.EXTERNAL_SERVICE_ERROR,
    );
    retryAfterSeconds = Math.max(
      1,
      Math.ceil((err.nextAttemptAt.getTime() - Date.now()) / 1000),
    );
  } else if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof PrismaClientKnownRequestError) {
    appError = fromPrismaError(err);
  } else if (
    err instanceof SyntaxError &&
    typeof (err as any).status === 'number' &&
    (err as any).status === 400 &&
    (err as any).type === 'entity.parse.failed'
  ) {
    appError = new ValidationError('Malformed JSON body');
  } else if (
    (err as any)?.type === 'entity.too.large' ||
    (err as any)?.status === 413
  ) {
    appError = new AppError('Payload too large', 413, 'PAYLOAD_TOO_LARGE');
  } else if (err instanceof PrismaClientValidationError) {
    appError = new ValidationError('Invalid database query parameters');
  } else if (err instanceof Error) {
    appError = new AppError(err.message || 'Internal Server Error', 500, ErrorCode.INTERNAL_SERVER_ERROR);
  } else {
    appError = new AppError('Internal Server Error', 500, ErrorCode.INTERNAL_SERVER_ERROR);
  }

  const isDev = process.env.NODE_ENV === 'development';
  const requestId = (req as any).requestId;
  const timestamp = new Date().toISOString();

  logger.error(`[${appError.code}] ${req.method} ${req.path} → ${appError.statusCode}`, {
    code: appError.code,
    statusCode: appError.statusCode,
    message: appError.message,
    requestId,
    timestamp,
    path: req.originalUrl,
    ...(appError.details && { details: appError.details }),
    ...(isDev && err instanceof Error && { stack: err.stack }),
  });

  const body: ErrorResponse & { stack?: string } = {
    error: appError.message || appError.name, // Ensure textual summary error field is clear
    message: appError.message,
    code: appError.code,
    path: req.originalUrl, // <-- Explicitly mapped parameter requirement
    requestId,
    timestamp,
    ...(retryAfterSeconds !== undefined && { retryAfter: retryAfterSeconds }),
    ...(appError.details && { details: appError.details }),
    ...(isDev && err instanceof Error && { stack: err.stack }),
  };

  if (retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  res.status(appError.statusCode).json(body);
}

/**
 * Wraps an async route handler so unhandled promise rejections are
 * automatically forwarded to the error handler via `next(error)`.
 *
 * Usage:
 * router.get('/path', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}
