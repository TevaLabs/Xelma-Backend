import { Request, Response, NextFunction } from 'express';

export const notFoundMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
  });
};