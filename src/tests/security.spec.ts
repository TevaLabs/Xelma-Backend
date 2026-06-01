/**
 * Tests for security headers and CORS policy behavior (Issue #150).
 *
 * Uses mocked Prisma so no database is required.
 * All assertions are against the Express HTTP layer (createApp / supertest).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import {
  getAdminRoutes,
  getOracleRoutes,
  registryKey,
  RouteAuthLevel,
  ROUTE_AUTH_REGISTRY,
} from "../security/route-auth.registry";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    authChallenge: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    transaction: { create: jest.fn(), deleteMany: jest.fn() },
    notification: { findMany: jest.fn(), count: jest.fn() },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const passthroughLimiter = (_req: any, _res: any, next: any) => next();

jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: passthroughLimiter,
  connectRateLimiter: passthroughLimiter,
  authRateLimiter: passthroughLimiter,
  chatMessageRateLimiter: passthroughLimiter,
  predictionRateLimiter: passthroughLimiter,
  batchPredictionRateLimiter: passthroughLimiter,
  batchLeaderboardRateLimiter: passthroughLimiter,
  adminRoundRateLimiter: passthroughLimiter,
  oracleResolveRateLimiter: passthroughLimiter,
}));

const originalEnv = process.env;

function setEnv(overrides: Record<string, string | undefined>): void {
  process.env = { ...originalEnv, ...overrides };
}

function restoreEnv(): void {
  process.env = originalEnv;
}

// ── Security headers ─────────────────────────────────────────────────────────

describe("Security headers", () => {
  let app: Express;

  beforeAll(() => {
    const { createApp } = require("../index");
    app = createApp();
  });

  afterAll(restoreEnv);

  const PROBE_ROUTES = ["/", "/health", "/api/auth/challenge"];

  for (const route of PROBE_ROUTES) {
    it(`sets X-Content-Type-Options: nosniff on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it(`sets X-Frame-Options: DENY on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });

    it(`sets X-XSS-Protection on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["x-xss-protection"]).toBe("1; mode=block");
    });

    it(`sets Referrer-Policy on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });

    it(`sets Content-Security-Policy on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["content-security-policy"]).toContain("default-src");
    });

    it(`sets Permissions-Policy on ${route}`, async () => {
      const res = await request(app).get(route);
      expect(res.headers["permissions-policy"]).toBeDefined();
    });
  }
});

// ── CORS — development (permissive) ─────────────────────────────────────────

describe("CORS in development mode", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("allows any origin when CLIENT_URL is unset (development)", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: undefined, JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "http://localhost:5173");

    // CORS with origin: true reflects any origin
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("returns the CLIENT_URL as the allowed origin when set in development", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "http://localhost:5173");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("blocks an origin not in the allowlist (development with explicit CLIENT_URL)", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "http://evil.example.com");

    // The header must not be the evil origin
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});

// ── CORS — production (strict) ───────────────────────────────────────────────

describe("CORS in production mode", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("allows the CLIENT_URL origin in production", async () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      JWT_SECRET: "test-secret",
    });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "https://app.example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("blocks an origin not in the production allowlist", async () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      JWT_SECRET: "test-secret",
    });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "https://evil.example.com");

    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
  });

  it("allows additional origins from ALLOWED_ORIGINS in production", async () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com,https://dev.example.com",
      JWT_SECRET: "test-secret",
    });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "https://staging.example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("https://staging.example.com");
  });

  it("throws when CLIENT_URL is missing in production (at module load / createApp call)", () => {
    setEnv({ NODE_ENV: "production", CLIENT_URL: undefined, JWT_SECRET: "test-secret" });
    jest.resetModules();
    // require('../index') itself calls createApp() at module level — it throws
    expect(() => require("../index")).toThrow("CLIENT_URL");
  });
});

// ── CORS — preflight (OPTIONS) ───────────────────────────────────────────────

describe("CORS preflight requests", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("responds to OPTIONS preflight with 204 for an allowed origin", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .options("/api/auth/challenge")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type,Authorization");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toBeDefined();
  });

  it("includes Authorization in Access-Control-Allow-Headers for preflight", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .options("/api/user/profile")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "PATCH")
      .set("Access-Control-Request-Headers", "Authorization,Content-Type");

    expect(res.status).toBe(204);
    const allowedHeaders = res.headers["access-control-allow-headers"] ?? "";
    expect(allowedHeaders.toLowerCase()).toContain("authorization");
  });

  it("sets Access-Control-Allow-Credentials on preflight", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .options("/api/user/profile")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "PATCH");

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});

// ── getHttpCorsOrigins() unit tests ──────────────────────────────────────────

describe("getHttpCorsOrigins()", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("returns true (allow all) in development when CLIENT_URL is unset", () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: undefined, JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe(true);
  });

  it("returns CLIENT_URL string in development when set", () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe("http://localhost:5173");
  });

  it("returns CLIENT_URL string in production when only CLIENT_URL is set", () => {
    setEnv({ NODE_ENV: "production", CLIENT_URL: "https://app.example.com", JWT_SECRET: "test-secret" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe("https://app.example.com");
  });

  it("returns an array combining CLIENT_URL and ALLOWED_ORIGINS in production", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com , https://dev.example.com",
      JWT_SECRET: "test-secret",
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
      "https://dev.example.com",
    ]);
  });

  it("throws in production when CLIENT_URL is missing", () => {
    setEnv({ NODE_ENV: "production", CLIENT_URL: undefined, JWT_SECRET: "test-secret" });
    jest.resetModules();
    // require('../index') itself calls createApp() at module level — it throws
    expect(() => require("../index")).toThrow("CLIENT_URL");
  });

  it("ignores empty entries in ALLOWED_ORIGINS", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com,,",
      JWT_SECRET: "test-secret",
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    const result = getHttpCorsOrigins() as string[];
    expect(result).not.toContain("");
    expect(result).toContain("https://app.example.com");
    expect(result).toContain("https://staging.example.com");
  });
});

// ── Route authorization registry (drift prevention) ─────────────────────────

describe("Route authorization registry", () => {
  it("has unique registry keys for every documented route", () => {
    const keys = ROUTE_AUTH_REGISTRY.map(registryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("blocks non-admin users from admin registry routes", async () => {
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-secret" });
    jest.resetModules();

    const { prisma: freshPrisma } = require("../lib/prisma") as {
      prisma: { user: { findUnique: jest.Mock } };
    };
    const { generateToken: freshGenerateToken } = require("../utils/jwt.util");

    const regularUser = {
      id: "user-regular",
      walletAddress: "GUSER_REGULAR_TEST_AAAAAAAAAAAAAAA",
      role: UserRole.USER,
    };
    freshPrisma.user.findUnique.mockResolvedValue(regularUser);
    const token = freshGenerateToken(
      regularUser.id,
      regularUser.walletAddress,
      regularUser.role,
    );

    const { createApp } = require("../index");
    const app = createApp();

    for (const route of getAdminRoutes()) {
      const path = route.path.replace(":id", "test-id");
      const method = route.method.toLowerCase() as "get" | "post";
      const req = request(app)[method](path).set("Authorization", `Bearer ${token}`);
      const res = await req;

      expect(res.status).toBe(403);
    }
  });

  it("blocks regular users from starting rounds (oracle/admin only actions)", async () => {
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-secret" });
    jest.resetModules();

    const { prisma: freshPrisma } = require("../lib/prisma") as {
      prisma: { user: { findUnique: jest.Mock } };
    };
    const { generateToken: freshGenerateToken } = require("../utils/jwt.util");

    const regularUser = {
      id: "user-regular-2",
      walletAddress: "GUSER_REGULAR2_TEST_AAAAAAAAAAAAAA",
      role: UserRole.USER,
    };
    freshPrisma.user.findUnique.mockResolvedValue(regularUser);
    const token = freshGenerateToken(
      regularUser.id,
      regularUser.walletAddress,
      regularUser.role,
    );

    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .post("/api/rounds/start")
      .set("Authorization", `Bearer ${token}`)
      .send({ mode: 0, startPrice: 0.5, duration: 60 });

    expect(res.status).toBe(403);
  });

  it("documents oracle routes separately from admin routes", () => {
    const oracleOnly = getOracleRoutes().filter(
      (r) => r.auth === RouteAuthLevel.ORACLE,
    );
    expect(oracleOnly.length).toBeGreaterThan(0);
    expect(getAdminRoutes().some((r) => r.path === "/api/rounds/:id/resolve")).toBe(
      false,
    );
  });
});
