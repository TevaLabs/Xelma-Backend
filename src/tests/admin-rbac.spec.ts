/**
 * Admin RBAC matrix + immutable audit trail (Issue #497).
 *
 * Covers three things the acceptance criteria call out:
 *  1. the role → permission matrix itself (ADMIN vs USER vs ORACLE);
 *  2. HTTP enforcement on every `/api/admin/*` route (401 anonymous,
 *     403 non-admin, allowed for ADMIN) with an append-only audit record;
 *  3. hackathon/demo mode keeping the admin surface off by default.
 *
 * Prisma is mocked, so no database is required.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  jest,
} from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    // append-only surface: create is the only method the app may call.
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: "audit-1" }),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();

jest.mock("../middleware/rateLimiter.middleware", () => ({
  apiRateLimiter: passthrough,
  writeRateLimiter: passthrough,
  betRateLimiter: passthrough,
  challengeRateLimiter: passthrough,
  connectRateLimiter: passthrough,
  authRateLimiter: passthrough,
  chatMessageRateLimiter: passthrough,
  predictionRateLimiter: passthrough,
  adminRoundRateLimiter: passthrough,
  oracleResolveRateLimiter: passthrough,
  batchPredictionRateLimiter: passthrough,
  batchLeaderboardRateLimiter: passthrough,
}));

import { createApp } from "../index";
import {
  createApp as createAppFromFactory,
  isCorsDiagnosticsEnabled,
  resolveFeatures,
} from "../app-factory";
import { extractRoutes, routeKey } from "../security/route-parity.registry";
import {
  AdminPermission,
  ALL_ADMIN_PERMISSIONS,
  getAdminPermissions,
  isAdminRole,
  roleHasAdminPermission,
} from "../security/admin-permissions";
import {
  getAdminRoutes,
  getAdminRoutesWithPermissions,
} from "../security/route-auth.registry";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";

const mockPrisma = prisma as any;

// Preflight needs JWT_SECRET ≥ 16 chars and the middleware verifies tokens at
// request time, so pin one value before any token is generated.
const TEST_JWT_SECRET = "admin-rbac-matrix-test-jwt-secret-2026-x";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const ADMIN_ADDRESS = "GADMIN_RBAC_AAAAAAAAAAAAAAAAAAAAAAAAAA";
const USER_ADDRESS = "GUSER_RBAC_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ORACLE_ADDRESS = "GORACLE_RBAC_CCCCCCCCCCCCCCCCCCCCCCCCCCC";

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Every admin route mounted under /api/admin, with its declared permission. */
const adminApiRoutes = getAdminRoutesWithPermissions().filter((route) =>
  route.path.startsWith("/api/admin/"),
);

describe("admin RBAC matrix", () => {
  it("grants ADMIN every permission", () => {
    for (const permission of ALL_ADMIN_PERMISSIONS) {
      expect(roleHasAdminPermission(UserRole.ADMIN, permission)).toBe(true);
    }
    expect(getAdminPermissions(UserRole.ADMIN)).toEqual(
      expect.arrayContaining([...ALL_ADMIN_PERMISSIONS]),
    );
  });

  it("grants USER and ORACLE no admin permissions", () => {
    expect(getAdminPermissions(UserRole.USER)).toEqual([]);
    expect(getAdminPermissions(UserRole.ORACLE)).toEqual([]);
    expect(isAdminRole(UserRole.USER)).toBe(false);
    expect(isAdminRole(UserRole.ORACLE)).toBe(false);
    expect(isAdminRole(UserRole.ADMIN)).toBe(true);
  });

  it("fails closed for unknown roles", () => {
    expect(getAdminPermissions(undefined)).toEqual([]);
    expect(getAdminPermissions(null)).toEqual([]);
    expect(getAdminPermissions("SUPERUSER")).toEqual([]);
    expect(roleHasAdminPermission("SUPERUSER", AdminPermission.DLQ_REPLAY)).toBe(
      false,
    );
    expect(isAdminRole(undefined)).toBe(false);
  });

  it("requires a declared permission on every /api/admin registry route", () => {
    const adminPaths = getAdminRoutes().filter((r) =>
      r.path.startsWith("/api/admin/"),
    );
    expect(adminPaths.length).toBeGreaterThan(0);

    for (const route of adminPaths) {
      expect(route.permission).toBeDefined();
      // The declared permission must be a real member of the enum.
      expect(Object.values(AdminPermission)).toContain(route.permission);
    }

    // And getAdminRoutesWithPermissions() must return exactly those.
    expect(getAdminRoutesWithPermissions().map((r) => r.path).sort()).toEqual(
      adminPaths.map((r) => r.path).sort(),
    );
  });
});

describe("admin routes enforce the matrix over HTTP", () => {
  let app: Express;
  let adminToken: string;
  let userToken: string;

  beforeAll(() => {
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    adminToken = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
    userToken = generateToken("user-id", USER_ADDRESS, UserRole.USER);
    app = createApp();
  });

  beforeEach(() => {
    mockPrisma.user.findUnique.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === "admin-id") {
        return { id: "admin-id", walletAddress: ADMIN_ADDRESS, role: UserRole.ADMIN };
      }
      if (id === "user-id") {
        return { id: "user-id", walletAddress: USER_ADDRESS, role: UserRole.USER };
      }
      return null;
    });
  });

  it("exposes every admin registry route on the full app", () => {
    const mounted = new Set(extractRoutes(app).map(routeKey));
    for (const route of adminApiRoutes) {
      expect(mounted.has(`${route.method} ${route.path}`)).toBe(true);
    }
  });

  for (const route of adminApiRoutes) {
    const path = route.path.replace(":id", "entry-1");
    const method = route.method.toLowerCase() as "get" | "post";

    it(`401s anonymous callers on ${route.method} ${route.path}`, async () => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it(`403s USER callers on ${route.method} ${route.path}`, async () => {
      const res = await request(app)
        [method](path)
        .set("Authorization", `Bearer ${userToken}`);
      expect(res.status).toBe(403);
    });

    it(`admits ADMIN callers on ${route.method} ${route.path}`, async () => {
      const res = await request(app)
        [method](path)
        .set("Authorization", `Bearer ${adminToken}`);
      expect([401, 403]).not.toContain(res.status);
    });
  }

  it("records a denied privileged call in the audit log", async () => {
    mockPrisma.auditLog.create.mockClear();

    await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${userToken}`);
    await flush();

    const denied = mockPrisma.auditLog.create.mock.calls.find(
      (call: any[]) => call[0]?.data?.eventType === "admin.access.denied",
    );
    expect(denied).toBeDefined();
    expect(denied![0].data.metadata).toMatchObject({
      permission: AdminPermission.CORS_DIAGNOSTICS_READ,
      role: UserRole.USER,
      statusCode: 403,
    });
  });

  it("records an allowed privileged call in the audit log", async () => {
    mockPrisma.auditLog.create.mockClear();

    const res = await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    await flush();

    const action = mockPrisma.auditLog.create.mock.calls.find(
      (call: any[]) => call[0]?.data?.eventType === "admin.action",
    );
    expect(action).toBeDefined();
    expect(action![0].data.metadata).toMatchObject({
      permission: AdminPermission.CORS_DIAGNOSTICS_READ,
      role: UserRole.ADMIN,
      statusCode: 200,
    });
    expect(action![0].data.actorType).toBe("user");
    expect(action![0].data.userId).toBe("admin-id");
  });

  it("is append-only: never updates or deletes audit records", async () => {
    mockPrisma.auditLog.update.mockClear();
    mockPrisma.auditLog.updateMany.mockClear();
    mockPrisma.auditLog.delete.mockClear();
    mockPrisma.auditLog.deleteMany.mockClear();

    await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${adminToken}`);
    await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${userToken}`);
    await flush();

    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(mockPrisma.auditLog.update).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.delete).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});

describe("hackathon mode keeps the admin surface off", () => {
  it("defaults adminRoutes and corsDiagnostics to off", () => {
    const features = resolveFeatures("hackathon");
    expect(features.adminRoutes).toBe(false);
    expect(features.corsDiagnostics).toBe(false);
  });

  it("only enables CORS diagnostics for an explicit ENABLE_CORS_DIAGNOSTICS=true", () => {
    expect(
      isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: "true" } as any),
    ).toBe(true);
    expect(
      isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: "false" } as any),
    ).toBe(false);
    expect(
      isCorsDiagnosticsEnabled({ ENABLE_CORS_DIAGNOSTICS: "1" } as any),
    ).toBe(false);
    expect(isCorsDiagnosticsEnabled({} as any)).toBe(false);
  });

  it("mounts no /api/admin route on the hackathon app by default", () => {
    const routes = extractRoutes(createAppFromFactory({ mode: "hackathon" })).map(
      routeKey,
    );
    expect(routes.filter((r) => r.includes("/api/admin/"))).toEqual([]);
  });

  it("404s privileged admin paths on the hackathon app", async () => {
    const hackathonApp = createAppFromFactory({ mode: "hackathon" });
    const res = await request(hackathonApp).get("/api/admin/dead-letter");
    expect(res.status).toBe(404);
  });
});
