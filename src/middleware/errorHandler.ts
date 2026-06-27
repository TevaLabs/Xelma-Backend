import { Request, Response, NextFunction } from 'express';

/**
 * Centralized error handler middleware.
 * Catches all thrown/async errors and formats them as a consistent JSON response.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  try {
    const statusCode = err.statusCode || err.status || 500;
    const errorName = err.name || 'InternalServerError';
    const message = err.message || 'Internal Server Error';
    const code = err.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : undefined);

    res.status(statusCode).json({
      error: errorName,
      message: message,
      ...(code ? { code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  } catch (error) {
    console.error('Error in error handler middleware:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.',
    });
  }
}
