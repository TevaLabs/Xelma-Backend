import { NextFunction, Request, Response } from "express";
import { NotFoundError } from "../utils/errors";

export function notFound(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}
