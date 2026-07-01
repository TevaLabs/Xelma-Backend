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
