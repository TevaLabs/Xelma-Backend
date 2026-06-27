import { Request, Response } from 'express';

/**
 * 404 handler for unknown routes.
 * Returns a simple JSON payload for frontend-friendly error handling.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
  });
}
