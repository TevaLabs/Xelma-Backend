import { Request, Response } from 'express';

/**
 * Single 404 handler mounted by both app entrypoints (full and hackathon).
 *
 * Previously the full app forwarded unmatched routes into its error handler
 * as a `NotFoundError` (producing `{ error, message, code, path, requestId,
 * timestamp }`) while the hackathon app used this handler directly, which
 * only returned `{ error: 'Not Found', path }`. Clients had to special-case
 * two different 404 shapes depending on which entrypoint they hit. This
 * handler now emits the same standard error envelope used elsewhere in the
 * API for both entrypoints (#637).
 */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = (req as any).requestId;

  res.status(404).json({
    error: 'NotFoundError',
    message: `Route ${req.method} ${req.path} not found`,
    code: 'NOT_FOUND',
    path: req.path,
    timestamp: new Date().toISOString(),
    ...(requestId ? { requestId } : {}),
  });
}
