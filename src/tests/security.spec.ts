/**
 * Tests for security headers and CORS policy behavior (Issue #150).
 *
 * Uses mocked Prisma so no database is required.
 * All assertions are against the Express HTTP layer (createApp / supertest).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";

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

jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
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
