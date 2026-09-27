import type { Request, Response, NextFunction } from "express";
import logger from "../utils/logger";
import { verifyToken } from "../utils/jwt.util";
import type { AuthRequest } from "../types/auth.types";
import {
  getJsonFromCache,
  isRedisCacheEnabled,
  noteCacheBypass,
  setJsonToCache,
} from "../lib/redis";

/**
 * Who the cached response belongs to.
 *
 * - `"public"`  — byte-identical for every caller, authenticated or not.
 * - `"user"`    — varies per authenticated caller; the cache key MUST include
 *                 the caller's user id.
 *
 * Omitting `scope` is the fail-closed default: only requests that carry no
 * credentials are cached. See the rule documented on `cacheJsonResponse`.
 */
export type CacheScope = "public" | "user";

type CacheMiddlewareOptions = {
  namespace: string;
  ttlSeconds: number;
  /**
   * Compute a deterministic cache key from the request.
   * If not provided, defaults to `<path>?<sortedQuery>`.
   *
   * Only meaningful for `scope: "user"`, where the returned string must
   * incorporate the caller (the middleware additionally prefixes the user id
   * as a safety net — see `userScopedKey`).
   */
  keyFn?: (req: Request) => string;
  /**
   * Declares who the cached body belongs to. Omit it only for routes whose
   * response is public and where you are willing to lose caching for any
   * request that carries an `Authorization` header.
   */
  scope?: CacheScope;
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

function defaultKeyFn(req: Request): string {
  const query = serializeQuery(req.query);
  return query ? `${req.path}?${query}` : req.path;
}

function hasAuthorizationHeader(req: Request): boolean {
  const header = req.headers.authorization;
  return typeof header === "string" && header.trim().length > 0;
}

/**
 * Resolve the caller's user id without hitting the database.
 *
 * `req.user` is preferred (an upstream auth middleware already verified the
 * token). When the cache is mounted *before* authentication we fall back to
 * verifying the bearer token locally, so an authenticated caller is still
 * recognised as authenticated — and therefore still blocked from a shared
 * cache entry.
 *
 * @returns The user id, or `null` when the caller cannot be identified.
 */
function resolveUserId(req: Request): string | null {
  const attached = (req as AuthRequest).user?.userId;
  if (typeof attached === "string" && attached.length > 0) return attached;

  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;

  const payload = verifyToken(header.substring(7).trim());
  if (!payload?.userId) return null;

  return payload.userId;
}

/**
 * Build the key for a `scope: "user"` response.
 *
 * The `u:<userId>:` prefix is mandatory and not the route author's job: it
 * guarantees a per-user key even if a `keyFn` forgets the caller, so a stale
 * or careless `keyFn` can degrade a cache hit but can never serve one user's
 * body to another.
 */
function userScopedKey(userId: string, baseKey: string): string {
  return `u:${userId}:${baseKey}`;
}

/**
 * Redis-backed response cache for JSON GETs.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A cache entry is shared by everyone who can produce the same key, and Redis
 * holds no notion of who a key belongs to. Therefore:
 *
 *   Requests carrying an `Authorization` header are NEVER served from — or
 *   written to — a globally shared cache entry, unless the mount explicitly
 *   declares `scope: "public"` (response identical for every caller) or
 *   `scope: "user"` (key is scoped to the caller's user id).
 *
 * With `scope` omitted, an authenticated request bypasses the cache entirely
 * (`Cache-Control: private, no-store`). This is a fail-closed default: adding
 * `cacheJsonResponse` to a route that needs `req.user` degrades to "no cache",
 * never to "shared cache".
 *
 * User-specific responses are served with `Cache-Control: private` so shared
 * proxies/CDNs do not re-introduce the leak downstream.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function cacheJsonResponse(opts: CacheMiddlewareOptions) {
  let warnedMissingUserKeyFn = false;

  return async (req: Request, res: Response, next: NextFunction) => {
    // If Redis cache isn't enabled, keep request semantics unchanged.
    if (!isRedisCacheEnabled()) return next();

    const authenticated =
      hasAuthorizationHeader(req) || Boolean((req as AuthRequest).user);

    // ── Fail-closed scope resolution ─────────────────────────────────────────
    // A handler that reads `req.user` produces a different body per caller, so
    // an authenticated request may only use a shared entry when the mount
    // explicitly vouched for it with `scope: "public"`. Without a declaration
    // we assume the response is user-specific and keep it out of Redis.
    if (authenticated && opts.scope !== "public" && opts.scope !== "user") {
      noteCacheBypass(opts.namespace, "undeclared-scope");
      res.setHeader("Cache-Control", "private, no-store");
      return next();
    }

    // Only user-scoped mounts need to identify the caller.
    const userId = opts.scope === "user" ? resolveUserId(req) : null;

    if (opts.scope === "user") {
      if (!opts.keyFn) {
        if (!warnedMissingUserKeyFn) {
          warnedMissingUserKeyFn = true;
          logger.warn(
            'cacheJsonResponse requires keyFn for scope: "user"; bypassing cache',
            { namespace: opts.namespace },
          );
        }
        noteCacheBypass(opts.namespace, "missing-user-keyfn");
        res.setHeader("Cache-Control", "private, no-store");
        return next();
      }
      if (!userId) {
        noteCacheBypass(opts.namespace, "missing-user");
        res.setHeader("Cache-Control", "private, no-store");
        return next();
      }
    }

    // Raw key is later namespaced + versioned by `src/lib/redis.ts`.
    // Default raw key format: `<path>?<sortedQuery>` (query parts sorted for
    // determinism). For `scope: "user"` the caller's id is always part of it.
    const baseKey = opts.keyFn ? opts.keyFn(req) : defaultKeyFn(req);
    const rawKey =
      opts.scope === "user" && userId ? userScopedKey(userId, baseKey) : baseKey;

    res.setHeader(
      "Cache-Control",
      opts.scope === "user" ? "private" : `public, max-age=${opts.ttlSeconds}`,
    );

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
