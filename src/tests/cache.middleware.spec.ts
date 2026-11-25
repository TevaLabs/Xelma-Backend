import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import express from "express";
import supertest from "supertest";
import { cacheJsonResponse } from "../middleware/cache.middleware";

// Mock the redis cache layer so no real Redis is required (unit test).
jest.mock("../lib/redis", () => ({
  getJsonFromCache: jest.fn(),
  setJsonToCache: jest.fn(),
  isRedisCacheEnabled: jest.fn(() => true),
}));

import {
  getJsonFromCache,
  isRedisCacheEnabled,
  setJsonToCache,
} from "../lib/redis";

const mockUser = {
  userId: "user-123",
  walletAddress: "GAAAAA...",
  role: "USER",
};

describe("cache.middleware (Issue #1058)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isRedisCacheEnabled as jest.Mock).mockReturnValue(true);
    (getJsonFromCache as jest.Mock).mockResolvedValue(null);
  });

  it("scopes the Redis cache key by authenticated user id", async () => {
    const app = express();
    // Attach an authenticated user to every request (simulates the auth middleware).
    app.use((req, res, next) => {
      (req as any).user = mockUser;
      next();
    });
    app.use(cacheJsonResponse({ namespace: "profile", ttlSeconds: 60 }));
    app.get("/me", (_req, res) => res.json({ balance: 100 }));

    const agent = supertest(app);
    await agent.get("/me").expect(200);

    // The raw key passed to the cache layer must include the user segment.
    const setCall = (setJsonToCache as jest.Mock).mock.calls[0];
    expect(setCall).toBeDefined();
    const rawKey = setCall[1];
    expect(rawKey).toContain("/me");
    expect(rawKey).toContain(":user:user-123");
    expect(rawKey).not.toContain(":anon:");
  });

  it("scopes the Redis cache key by IP for unauthenticated requests", async () => {
    const app = express();
    app.use(cacheJsonResponse({ namespace: "public", ttlSeconds: 60 }));
    app.get("/public", (_req, res) => res.json({ value: 1 }));

    const agent = supertest(app);
    await agent.get("/public").expect(200);

    const setCall = (setJsonToCache as jest.Mock).mock.calls[0];
    expect(setCall).toBeDefined();
    const rawKey = setCall[1];
    expect(rawKey).toContain("/public");
    expect(rawKey).toContain(":anon:");
    expect(rawKey).not.toContain(":user:");
  });

  it("isolates different users so one never reads another's cache entry", async () => {
    const app = express();
    app.use((req, res, next) => {
      (req as any).user = mockUser;
      next();
    });
    app.use(cacheJsonResponse({ namespace: "profile", ttlSeconds: 60 }));
    app.get("/me", (_req, res) => res.json({ balance: 100 }));

    const agent = supertest(app);
    await agent.get("/me").expect(200);

    const userKey = (setJsonToCache as jest.Mock).mock.calls[0][1];
    expect(userKey).toContain(":user:user-123");

    // A different user must produce a different cache key.
    jest.clearAllMocks();
    (isRedisCacheEnabled as jest.Mock).mockReturnValue(true);
    (getJsonFromCache as jest.Mock).mockResolvedValue(null);
    const app2 = express();
    app2.use((req, res, next) => {
      (req as any).user = { ...mockUser, userId: "user-456" };
      next();
    });
    app2.use(cacheJsonResponse({ namespace: "profile", ttlSeconds: 60 }));
    app2.get("/me", (_req, res) => res.json({ balance: 100 }));

    const agent2 = supertest(app2);
    await agent2.get("/me").expect(200);

    const otherKey = (setJsonToCache as jest.Mock).mock.calls[0][1];
    expect(otherKey).toContain(":user:user-456");
    expect(otherKey).not.toBe(userKey);
  });
});
