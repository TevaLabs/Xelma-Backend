import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { ValidationError } from '../utils/errors';

/**
 * Express middleware that validates request data against a Zod schema.
 * On failure, forwards a ValidationError to the centralized error handler.
 */
export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // Zod v4 stores errors in error.message as JSON string
      const errorData = JSON.parse(result.error.message);
      const details = errorData.map((e: any) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      return next(new ValidationError(details[0].message, details));
    }
    (req as any)[source] = result.data;
    next();
  };
}
