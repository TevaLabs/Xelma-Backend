import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

/**
 * Express middleware that validates request data against a Zod schema.
 * Returns 400 with a standardized error shape on failure.
 */
export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // Zod v4 stores errors in error.message as JSON string
      const errorData = JSON.parse(result.error.message);
      const details = errorData.map((e: any) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      const primaryMessage = details[0].message;
      return res.status(400).json({
        error: primaryMessage,
        message: primaryMessage,
        details,
      });
    }
    (req as any)[source] = result.data;
    next();
  };
}
