import type { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import {
  getJsonFromCache,
  isRedisCacheEnabled,
  setJsonToCache,
} from "../lib/redis";

type CacheMiddlewareOptions = {
  namespace: string;
  ttlSeconds: number;
  /**
   * Compute a deterministic cache key from the request.
   * If not provided, defaults to `<path>?<sortedQuery>`.
   */
  keyFn?: (req: Request) => string;
};

function serializeQuery(query: Request["query"]): string {
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) params.append(key, String(value));
    } else {
      params.set(key, String(rawValue));
    }
  }
  return params.toString();
}

export function cacheJsonResponse(opts: CacheMiddlewareOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // If Redis cache isn't enabled, keep request semantics unchanged.
    if (!isRedisCacheEnabled()) return next();

    // Raw key is later namespaced + versioned by `src/lib/redis.ts`.
    // Default raw key format: `<path>?<sortedQuery>` (query parts sorted for determinism).
    const rawKey = opts.keyFn
      ? opts.keyFn(req)
      : (() => {
          const query = serializeQuery(req.query);
          return query ? `${req.path}?${query}` : req.path;
        })();

    try {
      const cached = await getJsonFromCache<unknown>(opts.namespace, rawKey);
      if (cached) {
        res.json(cached);
        return;
      }
    } catch (error) {
      // Cache must never break the request.
      logger.warn("Cache read failed; bypassing cache", {
        namespace: opts.namespace,
        rawKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const originalJson = res.json.bind(res);

    // Monkey-patch res.json to capture successful responses.
    (res as any).json = (body: any) => {
      try {
        const shouldCache =
          res.statusCode >= 200 && res.statusCode < 300;

        if (shouldCache) {
          void setJsonToCache(opts.namespace, rawKey, body, opts.ttlSeconds).catch(
            () => {
              // Already logged inside setJsonToCache; ignore here.
            },
          );
        }
      } catch (error) {
        // Never break response serialization.
      }

      return originalJson(body);
    };

    next();
  };
}

