import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { generateToken } from "../utils/jwt.util";
import { createApp, resolveFeatures, CreateAppOptions } from "../app-factory";
import { getAdminRoutes, ROUTE_AUTH_REGISTRY } from "../security/route-auth.registry";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockPrisma = jest.requireMock("../lib/prisma").prisma as any;

const TEST_JWT_SECRET = "admin-rbac-test-jwt-secret-2026-xx";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const ADMIN_ADDRESS = "GADMIN_RBAC_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USER_ADDRESS = "GUSER_RBAC_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
const USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);

function buildApp(options: CreateAppOptions = {}): Express {
  return createApp({ mode: "full", ...options });
}

async function flushAudit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("Admin RBAC matrix + audit log (Issue #497)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id ?? args?.where?.walletAddress;
      if (id === USER_ADDRESS || id === "user-id") {
        return Promise.resolve({ id: "user-id", walletAddress: USER_ADDRESS, role: UserRole.USER });
      }
      return Promise.resolve({ id: "admin-id", walletAddress: ADMIN_ADDRESS, role: UserRole.ADMIN });
    });
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it("registers every admin surface at ADMIN level", () => {
    const adminPaths = getAdminRoutes().map((route) => route.path);
    expect(adminPaths).toEqual(
      expect.arrayContaining([
        "/api/admin/metrics/rate-limits",
        "/api/admin/metrics/rate-limits/clear",
        "/api/admin/metrics/metrics",
        "/api/admin/cors-diagnostics",
        "/api/admin/dead-letter",
        "/api/admin/dead-letter/retry-all",
        "/api/admin/dead-letter/:id/retry",
        "/api/admin/bet-audit",
        "/api/rounds/start",
      ]),
    );
    // `/api/admin/runtime-flags` must not slip back to a weaker level.
    expect(
      ROUTE_AUTH_REGISTRY.find((r) => r.path === "/api/admin/runtime-flags")?.auth,
    ).toBe("admin");
  });

  it("returns 403 for USER on every admin route", async () => {
    const app = buildApp();
    const adminEntries = getAdminRoutes();

    for (const entry of adminEntries) {
      const res = await request(app)
        [entry.method.toLowerCase() as "get" | "post"](entry.path)
        .set("Authorization", `Bearer ${USER_TOKEN}`)
        .send({});

      expect({ path: entry.path, status: res.status }).toEqual({
        path: entry.path,
        status: 403,
      });
    }
  });

  it("allows ADMIN through the admin surfaces", async () => {
    const app = buildApp();

    const flags = await request(app)
      .get("/api/admin/runtime-flags")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(flags.status).toBe(200);

    const cors = await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(cors.status).toBe(200);

    const audit = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(audit.status).toBe(200);
  });

  it("writes an immutable audit event for privileged reads", async () => {
    const app = buildApp();

    const res = await request(app)
      .get("/api/admin/runtime-flags")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    await flushAudit();

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "admin.action",
          outcome: "success",
          actorType: "user",
          walletAddress: ADMIN_ADDRESS,
          userId: "admin-id",
          endpoint: "/api/admin/runtime-flags",
          method: "GET",
          resourceType: "admin",
          resourceId: "admin.runtime_flags.read",
        }),
      }),
    );
  });

  it("does not audit forbidden admin attempts (only authorized actions)", async () => {
    const app = buildApp();

    const res = await request(app)
      .get("/api/admin/runtime-flags")
      .set("Authorization", `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(403);
    await flushAudit();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe("hackathon mode", () => {
    it("keeps admin surface off by default", async () => {
      expect(resolveFeatures("hackathon").adminRoutes).toBe(false);
      expect(resolveFeatures("full").adminRoutes).toBe(true);

      const app = buildApp({ mode: "hackathon" });
      const res = await request(app)
        .get("/api/admin/runtime-flags")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(404);
    });

    it("still enforces admin auth on the independently mounted CORS diagnostics", async () => {
      // HACKATHON_FEATURES reads ENABLE_CORS_DIAGNOSTICS at import time, so the
      // override mirrors an app booted with the flag enabled.
      const app = buildApp({ mode: "hackathon", features: { corsDiagnostics: true } });

      const asUser = await request(app)
        .get("/api/admin/cors-diagnostics")
        .set("Authorization", `Bearer ${USER_TOKEN}`);
      expect(asUser.status).toBe(403);

      const asAdmin = await request(app)
        .get("/api/admin/cors-diagnostics")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(asAdmin.status).toBe(200);
    });
  });
});
