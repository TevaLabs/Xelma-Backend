import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";
import { createApp } from "../index";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    auditLog: { create: jest.fn() },
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockPrisma = prisma as any;

process.env.JWT_SECRET = "test-secret-at-least-16-chars-long";

describe("Admin list users by role (#970)", () => {
  let app: Express;
  const ADMIN_ADDRESS = "GADMIN_TEST_AAAAAAAAAAAAAAAAAAAAAAAA";
  const USER_ADDRESS = "GUSER_TEST_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
  const USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id ?? args?.where?.walletAddress;
      if (id === USER_ADDRESS || id === "user-id") {
        return Promise.resolve({ id: "user-id", walletAddress: USER_ADDRESS, role: UserRole.USER });
      }
      return Promise.resolve({ id: "admin-id", walletAddress: ADMIN_ADDRESS, role: UserRole.ADMIN });
    });
    mockPrisma.user.count.mockResolvedValue(3);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "a", walletAddress: "GA", role: UserRole.ORACLE, createdAt: new Date(), lastLoginAt: null },
    ]);
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = "test-secret-at-least-16-chars-long";
    app = createApp();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const res = await request(app).get("/api/admin/users").set("Authorization", `Bearer ${USER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("filters by role and paginates for admins", async () => {
    const res = await request(app)
      .get("/api/admin/users?role=ORACLE&page=2&limit=1")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    const args = mockPrisma.user.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ role: "ORACLE" });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(1);
  });

  it("lists all roles when no role given and caps limit at 100", async () => {
    const res = await request(app)
      .get("/api/admin/users?limit=500")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const args = mockPrisma.user.findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.take).toBe(100);
    expect(res.body.pagination.limit).toBe(100);
  });

  it("rejects an invalid role and bad paging", async () => {
    const bad = await request(app).get("/api/admin/users?role=NOPE").set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(bad.status).toBe(400);
    const bad2 = await request(app).get("/api/admin/users?page=0").set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(bad2.status).toBe(400);
  });
});
