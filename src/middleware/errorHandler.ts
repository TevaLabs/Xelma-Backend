import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { ErrorCode } from '../utils/errors';

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
    // app-factory still selects separate full and hackathon handlers; sharing
    // them would alter the hackathon legacy envelope, so keep this narrow
    // malformed-JSON branch aligned with errorHandler.middleware.ts.
    if (err?.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && (err as any).status === 400 && 'body' in err)) {
      const requestId = (req as any).requestId;
      logger.error('[INVALID_JSON] Request body parsing failed', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(400).type('application/json').json({
        error: 'Bad Request',
        message: 'Invalid JSON in request body',
        code: ErrorCode.INVALID_JSON,
        path: req.originalUrl,
        requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

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
    logger.error("Error in error handler middleware", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.',
    });
  }
}
