import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Standardized error response shape.
 * All error responses from this API follow this contract.
 */
export interface ErrorResponse {
  error: string;
  message: string;
  code?: string;
  details?: { field: string; message: string }[];
}

/**
 * Maps a Prisma known-request error to an AppError.
 */
function fromPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2025':
      // Record not found
      return new AppError(
        (err.meta?.cause as string | undefined) ?? 'Record not found',
        404,
        'NOT_FOUND',
      );
    case 'P2002': {
      const fields = Array.isArray(err.meta?.target)
        ? (err.meta!.target as string[]).join(', ')
        : 'field';
      return new AppError(`Unique constraint failed on: ${fields}`, 409, 'CONFLICT');
    }
    case 'P2003':
      return new AppError('Related record not found', 400, 'FOREIGN_KEY_VIOLATION');
    default:
      return new AppError('Database error', 500, 'DATABASE_ERROR');
  }
}

/**
 * Central Express error-handling middleware.
 *
 * Register this LAST in src/index.ts so it catches errors forwarded
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

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appError = fromPrismaError(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    appError = new ValidationError('Invalid database query parameters');
  } else if (err instanceof Error) {
    appError = new AppError(err.message || 'Internal Server Error', 500, 'INTERNAL_ERROR');
  } else {
    appError = new AppError('Internal Server Error', 500, 'INTERNAL_ERROR');
  }

  const isDev = process.env.NODE_ENV === 'development';

  logger.error(`[${appError.code}] ${req.method} ${req.path} → ${appError.statusCode}`, {
    code: appError.code,
    statusCode: appError.statusCode,
    message: appError.message,
    ...(appError.details && { details: appError.details }),
    ...(isDev && err instanceof Error && { stack: err.stack }),
  });

  const body: ErrorResponse & { stack?: string } = {
    error: appError.name,
    message: appError.message,
    code: appError.code,
    ...(appError.details && { details: appError.details }),
    ...(isDev && err instanceof Error && { stack: err.stack }),
  };

  res.status(appError.statusCode).json(body);
}

/**
 * Wraps an async route handler so unhandled promise rejections are
 * automatically forwarded to the error handler via `next(error)`.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
