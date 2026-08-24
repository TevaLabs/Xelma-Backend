/**
 * Tests for security headers and CORS policy behavior (Issue #150).
 *
 * Uses mocked Prisma so no database is required.
 * All assertions are against the Express HTTP layer (createApp / supertest).
 *
 * Issue #408: Verifies both main (src/index.ts) and hackathon (src/app.ts)
 * entrypoints share the same security headers via securityHeadersMiddleware.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
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

/** Router that passes everything through — used for route mocks. */
const passthroughRouter = (_req: any, _res: any, next: any) => next();

/**
 * Register all mocks needed by the hackathon app (src/app.ts) for the NEXT
 * require() call.  Uses `jest.doMock` (NOT hoisted) so these mocks do NOT
 * leak into the main-app / CORS / route-auth tests which rely on the real
 * config module.
 */
function setupHackathonMocks(): void {
  jest.doMock("../middleware/rateLimiter.middleware", () => ({
    apiRateLimiter: passthroughLimiter,
    writeRateLimiter: passthroughLimiter,
  }));
  jest.doMock("../middleware/notFound", () => ({
    notFoundHandler: (_req: any, res: any) => {
      res.status(404).json({ error: "Not Found", path: "" });
    },
  }));
  jest.doMock("../middleware/errorHandler", () => ({
    errorHandler: (_err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: "Internal Server Error" });
    },
  }));
  jest.doMock("../config", () => ({
    __esModule: true,
    default: {
      app: {
        port: 3000,
        nodeEnv: "test",
        clientUrl: "*",
        logLevel: "info",
        apiOnly: false,
        roundsMockMode: false,
        dataMode: "mock",
        dataStore: "postgres",
        enableSimulation: false,
        enableMultiplayerSocial: false,
      },
      jwt: {
        secret: "test-jwt-secret-for-mock",
        expiry: "7d",
      },
      database: {
        url: "postgresql://mock:mock@localhost:5432/mock",
        connectionLimit: 10,
        poolTimeoutSeconds: 10,
        connectTimeoutSeconds: 10,
        statementTimeoutMs: 0,
        pgbouncer: false,
      },
      soroban: {
        contractId: "",
        network: "testnet",
        rpcUrl: "https://soroban-testnet.stellar.org",
        adminSecret: "",
        oracleSecret: "",
      },
      scheduler: {
        autoResolveEnabled: false,
        autoResolveIntervalSeconds: 30,
        roundSchedulerEnabled: false,
        roundSchedulerMode: "UP_DOWN",
      },
      stellar: { network: "testnet" },
      socket: { clientUrl: "*" },
      oracle: {
        pollingIntervalMs: 10000,
        requestTimeoutMs: 5000,
        maxRetries: 3,
        stalenessThresholdMs: 60000,
        coinGeckoUrl: "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
        coinCapUrl: "https://api.coincap.io/v2/assets/stellar",
      },
    },
  }));
  jest.doMock("../utils/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  }));
  jest.doMock("../routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/health", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/stats", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/rounds", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/leaderboard", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/user.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/bets.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/tournaments.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/chat.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/notifications.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../routes/metrics.routes", () => ({ __esModule: true, default: passthroughRouter }));
  jest.doMock("../docs/hackathon-openapi", () => ({
    hackathonSwaggerSpec: {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {},
    },
  }));
}

// ── Security headers — main (full) app (src/index.ts) ──────────────────────

describe("Security headers — main app", () => {
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

// ── Security headers — hackathon app (src/app.ts) ──────────────────────────

describe("Security headers — hackathon app", () => {
  let app: Express;

  beforeAll(() => {
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    setupHackathonMocks();

    const module = require("../app");
    app = module.default || module.createApp();
  });

  afterAll(() => {
    restoreEnv();
    // Undo all jest.doMock registrations so they don't leak into other
    // tests that import from ../index (CORS, route-auth, etc.).
    jest.dontMock("../middleware/rateLimiter.middleware");
    jest.dontMock("../middleware/notFound");
    jest.dontMock("../middleware/errorHandler");
    jest.dontMock("../config");
    jest.dontMock("../utils/logger");
    jest.dontMock("../routes");
    jest.dontMock("../routes/health");
    jest.dontMock("../routes/stats");
    jest.dontMock("../routes/rounds");
    jest.dontMock("../routes/leaderboard");
    jest.dontMock("../routes/user.routes");
    jest.dontMock("../routes/bets.routes");
    jest.dontMock("../routes/tournaments.routes");
    jest.dontMock("../routes/chat.routes");
    jest.dontMock("../routes/notifications.routes");
    jest.dontMock("../routes/metrics.routes");
    jest.dontMock("../docs/hackathon-openapi");
    jest.resetModules();
  });

  // NOTE: The hackathon app does not have a root "/" route — all responses
  // to these paths will 404, but security headers are still set by the
  // shared middleware, which is what we're testing.
  const PROBE_ROUTES = ["/", "/docs", "/health"];

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

// ── Shared security headers — both apps match ────────────────────────────────

describe("Security headers parity — both apps share the same core headers", () => {
  afterEach(() => {
    restoreEnv();
    // Clean up jest.doMock registrations so they don't leak into subsequent
    // tests (CORS, route-auth, etc.) that import from ../index.
    jest.dontMock("../middleware/rateLimiter.middleware");
    jest.dontMock("../middleware/notFound");
    jest.dontMock("../middleware/errorHandler");
    jest.dontMock("../config");
    jest.dontMock("../utils/logger");
    jest.dontMock("../routes");
    jest.dontMock("../routes/health");
    jest.dontMock("../routes/stats");
    jest.dontMock("../routes/rounds");
    jest.dontMock("../routes/leaderboard");
    jest.dontMock("../routes/user.routes");
    jest.dontMock("../routes/bets.routes");
    jest.dontMock("../routes/tournaments.routes");
    jest.dontMock("../routes/chat.routes");
    jest.dontMock("../routes/notifications.routes");
    jest.dontMock("../routes/metrics.routes");
    jest.dontMock("../docs/hackathon-openapi");
    jest.resetModules();
  });

  it("main and hackathon apps set identical core security headers", async () => {
    // Load main app
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    const { createApp: createMainApp } = require("../index");
    const mainApp = createMainApp();
    const mainRes = await request(mainApp).get("/");

    // Load hackathon app (with its own isolated mocks)
    jest.resetModules();
    setupHackathonMocks();
    const hackathonModule = require("../app");
    const hackApp = hackathonModule.default || hackathonModule.createApp();
    const hackRes = await request(hackApp).get("/");

    // Core security headers must be identical across both apps
    expect(mainRes.headers["x-content-type-options"]).toBe(
      hackRes.headers["x-content-type-options"],
    );
    expect(mainRes.headers["x-frame-options"]).toBe(
      hackRes.headers["x-frame-options"],
    );
    expect(mainRes.headers["x-xss-protection"]).toBe(
      hackRes.headers["x-xss-protection"],
    );
    expect(mainRes.headers["referrer-policy"]).toBe(
      hackRes.headers["referrer-policy"],
    );
    expect(mainRes.headers["permissions-policy"]).toBe(
      hackRes.headers["permissions-policy"],
    );
    // Content-Security-Policy: both should at least contain default-src
    expect(mainRes.headers["content-security-policy"]).toContain("default-src");
    expect(hackRes.headers["content-security-policy"]).toContain("default-src");
  });
});

// ── CORS — development (permissive) ─────────────────────────────────────────

describe("CORS in development mode", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("allows any origin when CLIENT_URL is unset (development)", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: undefined, JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    const { createApp } = require("../index");
    const app = createApp();

    const res = await request(app)
      .get("/")
      .set("Origin", "http://localhost:5173");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("blocks an origin not in the allowlist (development with explicit CLIENT_URL)", async () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
      JWT_SECRET: "test-jwt-secret-for-tests-min-16",
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
      JWT_SECRET: "test-jwt-secret-for-tests-min-16",
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
      JWT_SECRET: "test-jwt-secret-for-tests-min-16",
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
    setEnv({ NODE_ENV: "production", CLIENT_URL: undefined, JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", CLIENT_URL: undefined, JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe(true);
  });

  it("returns CLIENT_URL string in development when set", () => {
    setEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe("http://localhost:5173");
  });

  it("returns CLIENT_URL string in production when only CLIENT_URL is set", () => {
    setEnv({ NODE_ENV: "production", CLIENT_URL: "https://app.example.com", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../index");
    expect(getHttpCorsOrigins()).toBe("https://app.example.com");
  });

  it("returns an array combining CLIENT_URL and ALLOWED_ORIGINS in production", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com , https://dev.example.com",
      JWT_SECRET: "test-jwt-secret-for-tests-min-16",
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
    setEnv({ NODE_ENV: "production", CLIENT_URL: undefined, JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
    jest.resetModules();
    // require('../index') itself calls createApp() at module level — it throws
    expect(() => require("../index")).toThrow("CLIENT_URL");
  });

  it("ignores empty entries in ALLOWED_ORIGINS", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com,,",
      JWT_SECRET: "test-jwt-secret-for-tests-min-16",
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
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
    setEnv({ NODE_ENV: "development", JWT_SECRET: "test-jwt-secret-for-tests-min-16" });
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
