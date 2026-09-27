import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { UserRole } from "@prisma/client";

/**
 * In-memory stand-in for the Redis JSON cache.
 *
 * `getJsonFromCache`/`setJsonToCache` are keyed exactly like the real thing
 * (`<namespace>:<rawKey>`), so a cross-user hit here is a cross-user hit in
 * Redis. Nothing in this suite needs a running Redis.
 */
jest.mock("../lib/redis", () => {
  const store = new Map<string, string>();
  const state = { enabled: true };
  return {
    __setCacheEnabled: (value: boolean) => {
      state.enabled = value;
    },
    isRedisCacheEnabled: () => state.enabled,
    getJsonFromCache: jest.fn(async (namespace: string, rawKey: string) => {
      const raw = store.get(`${namespace}:${rawKey}`);
      return raw === undefined ? null : JSON.parse(raw);
    }),
    setJsonToCache: jest.fn(
      async (namespace: string, rawKey: string, value: unknown) => {
        store.set(`${namespace}:${rawKey}`, JSON.stringify(value));
      },
    ),
    noteCacheBypass: jest.fn(),
    invalidateNamespace: jest.fn(async () => {
      store.clear();
    }),
  };
});

import * as redisLib from "../lib/redis";
import { cacheJsonResponse } from "../middleware/cache.middleware";
import { getJsonFromCache, noteCacheBypass, setJsonToCache } from "../lib/redis";

const setCacheEnabled = (redisLib as unknown as {
  __setCacheEnabled: (value: boolean) => void;
}).__setCacheEnabled;

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const TTL = 60;

const getJsonFromCacheMock = getJsonFromCache as unknown as jest.Mock;
const setJsonToCacheMock = setJsonToCache as unknown as jest.Mock;
const noteCacheBypassMock = noteCacheBypass as unknown as jest.Mock;

/** Token → identity, standing in for the real bearer-token auth flow. */
const TOKENS: Record<string, { userId: string; walletAddress: string }> = {
  "token-a": { userId: USER_A, walletAddress: "GA" },
  "token-b": { userId: USER_B, walletAddress: "GB" },
};

type RequestWithUser = express.Request & {
  user?: { userId: string; walletAddress: string; role: UserRole };
};

/**
 * Minimal stand-in for the auth middleware: sets `req.user` the same way
 * `requireRole` does, so the cache middleware sees a realistic request.
 */
function fakeAuth() {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const header = req.headers.authorization;
    const identity = header ? TOKENS[header.replace(/^Bearer /, "")] : undefined;
    if (identity) {
      (req as RequestWithUser).user = { ...identity, role: "USER" as UserRole };
    }
    next();
  };
}

function asUserA(req: express.Request) {
  return (req as RequestWithUser).user?.userId;
}

/** How many times the underlying handler actually ran (i.e. cache misses). */
let handlerCalls = 0;

function buildApp() {
  const app = express();

  // 1. Public route, no auth at all — must still cache.
  app.get(
    "/public",
    cacheJsonResponse({ namespace: "ns-public", ttlSeconds: TTL }),
    (req, res) => {
      handlerCalls += 1;
      res.json({ owner: "nobody" });
    },
  );

  // 2. Per-user route that correctly declares `scope: "user"` — must cache
  //    but never share across callers.
  app.get(
    "/me",
    fakeAuth(),
    cacheJsonResponse({
      namespace: "ns-user-scoped",
      ttlSeconds: TTL,
      scope: "user",
      keyFn: (req) => `${req.path}:${asUserA(req)}`,
    }),
    (req, res) => {
      handlerCalls += 1;
      res.json({ balance: asUserA(req) });
    },
  );

  // 3. The dangerous case: a handler that varies per caller mounted on the
  //    default key (`<path>?<query>`) with no scope declared. This is exactly
  //    the leak the issue describes — the key is identical for both users.
  app.get(
    "/leaky",
    fakeAuth(),
    cacheJsonResponse({ namespace: "ns-leaky", ttlSeconds: TTL }),
    (req, res) => {
      handlerCalls += 1;
      res.json({ secret: `secret-for-${asUserA(req)}` });
    },
  );

  // 4. `scope: "public"` on a response that is genuinely public — allowed to
  //    share, and required to keep authed callers on the shared entry.
  app.get(
    "/guides",
    fakeAuth(),
    cacheJsonResponse({
      namespace: "ns-guides",
      ttlSeconds: TTL,
      scope: "public",
    }),
    (req, res) => {
      handlerCalls += 1;
      res.json({ guides: ["volatility", "stellar", "oracles"] });
    },
  );

  return app;
}

describe("cache.middleware — per-user isolation", () => {
  beforeEach(() => {
    handlerCalls = 0;
    getJsonFromCacheMock.mockClear();
    setJsonToCacheMock.mockClear();
    noteCacheBypassMock.mockClear();
  });

  it("never serves one user's body to another on a path-only key", async () => {
    const app = buildApp();

    const a1 = await request(app).get("/leaky").set("Authorization", "Bearer token-a").expect(200);
    const b1 = await request(app).get("/leaky").set("Authorization", "Bearer token-b").expect(200);
    const a2 = await request(app).get("/leaky").set("Authorization", "Bearer token-a").expect(200);

    expect(a1.body).toEqual({ secret: `secret-for-${USER_A}` });
    expect(a2.body).toEqual({ secret: `secret-for-${USER_A}` });
    expect(b1.body).toEqual({ secret: `secret-for-${USER_B}` });
    expect(b1.body).not.toEqual(a1.body);

    // Every request reached the handler: nothing was read from or written to
    // the shared cache for an authenticated caller.
    expect(handlerCalls).toBe(3);
    expect(getJsonFromCacheMock).not.toHaveBeenCalled();
    expect(setJsonToCacheMock).not.toHaveBeenCalled();
    expect(noteCacheBypassMock).toHaveBeenCalledWith("ns-leaky", "undeclared-scope");
    expect(a1.headers["cache-control"]).toBe("private, no-store");
  });

  it("caches per-user responses without cross-user hits when scope is user", async () => {
    const app = buildApp();

    const a1 = await request(app).get("/me").set("Authorization", "Bearer token-a").expect(200);
    const a2 = await request(app).get("/me").set("Authorization", "Bearer token-a").expect(200);
    const b1 = await request(app).get("/me").set("Authorization", "Bearer token-b").expect(200);

    expect(a1.body).toEqual({ balance: USER_A });
    expect(a2.body).toEqual({ balance: USER_A }); // served from A's own entry
    expect(b1.body).toEqual({ balance: USER_B });

    // A's first request missed and populated its entry; A's second hit it; B
    // missed because its key is different.
    expect(handlerCalls).toBe(2);
    expect(getJsonFromCacheMock).toHaveBeenCalledTimes(3);
    expect(setJsonToCacheMock).toHaveBeenCalledTimes(2);

    const writtenKeys = setJsonToCacheMock.mock.calls.map((call) => call[1] as string);
    expect(new Set(writtenKeys).size).toBe(2);
    expect(writtenKeys.some((key) => key.includes(USER_A))).toBe(true);
    expect(writtenKeys.some((key) => key.includes(USER_B))).toBe(true);
    for (const key of writtenKeys) {
      // The user id is always part of the key, so no key can serve both users.
      const identities = [USER_A, USER_B].filter((id) => key.includes(id));
      expect(identities).toHaveLength(1);
    }

    const res = await request(app).get("/me").set("Authorization", "Bearer token-a").expect(200);
    expect(res.headers["cache-control"]).toBe("private");
    expect(res.body).toEqual({ balance: USER_A });
  });

  it("keeps public GETs cacheable for anonymous and authenticated callers", async () => {
    const app = buildApp();

    const anon1 = await request(app).get("/public").expect(200);
    const anon2 = await request(app).get("/public").expect(200);
    expect(anon1.body).toEqual(anon2.body);
    expect(anon1.headers["cache-control"]).toBe(`public, max-age=${TTL}`);
    expect(handlerCalls).toBe(1);

    handlerCalls = 0;
    getJsonFromCacheMock.mockClear();
    setJsonToCacheMock.mockClear();
    noteCacheBypassMock.mockClear();

    // A `scope: "public"` route keeps caching for authed callers too.
    const authed1 = await request(app)
      .get("/guides")
      .set("Authorization", "Bearer token-a")
      .expect(200);
    const authed2 = await request(app)
      .get("/guides")
      .set("Authorization", "Bearer token-b")
      .expect(200);

    expect(authed1.body).toEqual(authed2.body);
    expect(authed1.headers["cache-control"]).toBe(`public, max-age=${TTL}`);
    expect(handlerCalls).toBe(1);
    expect(setJsonToCacheMock).toHaveBeenCalledTimes(1);
    expect(noteCacheBypassMock).not.toHaveBeenCalled();
  });
});

describe("cache.middleware — fail-closed guards", () => {
  beforeEach(() => {
    handlerCalls = 0;
    getJsonFromCacheMock.mockClear();
    setJsonToCacheMock.mockClear();
    noteCacheBypassMock.mockClear();
  });

  it("bypasses the cache when keyFn is missing for scope: user", async () => {
    const app = express();
    app.get(
      "/broken",
      fakeAuth(),
      cacheJsonResponse({ namespace: "ns-broken", ttlSeconds: TTL, scope: "user" }),
      (req, res) => {
        handlerCalls += 1;
        res.json({ userId: asUserA(req) });
      },
    );

    await request(app).get("/broken").set("Authorization", "Bearer token-a").expect(200);
    await request(app).get("/broken").set("Authorization", "Bearer token-a").expect(200);

    expect(handlerCalls).toBe(2);
    expect(getJsonFromCacheMock).not.toHaveBeenCalled();
    expect(setJsonToCacheMock).not.toHaveBeenCalled();
    expect(noteCacheBypassMock).toHaveBeenCalledWith("ns-broken", "missing-user-keyfn");
  });

  it("bypasses a user-scoped cache when the caller cannot be identified", async () => {
    const app = express();
    app.get(
      "/unverified",
      cacheJsonResponse({
        namespace: "ns-unverified",
        ttlSeconds: TTL,
        scope: "user",
        keyFn: (req) => `${req.path}:${asUserA(req) ?? "anon"}`,
      }),
      (req, res) => {
        handlerCalls += 1;
        res.json({ ok: true });
      },
    );

    const res = await request(app)
      .get("/unverified")
      .set("Authorization", "Bearer not-a-jwt")
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(handlerCalls).toBe(1);
    expect(getJsonFromCacheMock).not.toHaveBeenCalled();
    expect(noteCacheBypassMock).toHaveBeenCalledWith("ns-unverified", "missing-user");
  });

  it("leaves request semantics untouched when Redis caching is off", async () => {
    setCacheEnabled(false);
    try {
      const app = express();
      app.get(
        "/nocache",
        fakeAuth(),
        cacheJsonResponse({ namespace: "ns-nocache", ttlSeconds: TTL, scope: "user" }),
        (req, res) => {
          handlerCalls += 1;
          res.json({ userId: asUserA(req) });
        },
      );

      const res = await request(app)
        .get("/nocache")
        .set("Authorization", "Bearer token-a")
        .expect(200);

      expect(res.body).toEqual({ userId: USER_A });
      expect(res.headers["cache-control"]).toBeUndefined();
      expect(getJsonFromCacheMock).not.toHaveBeenCalled();
      expect(setJsonToCacheMock).not.toHaveBeenCalled();
      expect(noteCacheBypassMock).not.toHaveBeenCalled();
    } finally {
      setCacheEnabled(true);
    }
  });
});
