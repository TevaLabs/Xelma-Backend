import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

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
    const path = req.originalUrl || req.path || '/';

    res.status(statusCode).json({
      error: errorName,
      message: message,
      ...(code ? { code } : {}),
      path,
      ...(err.details ? { details: err.details } : {}),
    });
  } catch (error) {
    logger.error("Error in error handler middleware", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.',
    });
  }
}
