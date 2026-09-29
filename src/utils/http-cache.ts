import { Request, Response, NextFunction } from "express";

/** Cache a public response for a short period while allowing CDN revalidation. */
export function setPublicCache(res: Response, seconds: number): void {
  const ttl = Math.max(0, Math.floor(seconds));
  res.setHeader(
    "Cache-Control",
    `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl}`,
  );
}

/** Prevent browsers and shared proxies from retaining private or health data. */
export function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

export function noStoreHeaders(_req: Request, res: Response, next: NextFunction): void {
  setNoStore(res);
  next();
}
