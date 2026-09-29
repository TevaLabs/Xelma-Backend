/**
 * Route-level coverage for the paginated admin dead-letter list (Issue #720).
 * Verifies the query caps (limit 1–100, default 20), the shared pagination
 * meta shape, authz, and the truncation flag surfaced for capped payloads.
 * Prisma is mocked so no database is required.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";
import { createApp } from "../index";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    failedDispatch: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPrisma = prisma as any;

const TEST_JWT_SECRET = "admin-dead-letter-test-jwt-secret-2026-x";
process.env.JWT_SECRET = TEST_JWT_SECRET;

describe("GET /api/admin/dead-letter (Issue #720)", () => {
  let app: Express;
  const ADMIN_ADDRESS = "GADMIN_DLQ_AAAAAAAAAAAAAAAAAAAAAAAA";
  const USER_ADDRESS = "GUSER_DLQ_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
  const USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id;
      if (id === "user-id") {
        return Promise.resolve({
          id: "user-id",
          walletAddress: USER_ADDRESS,
          role: UserRole.USER,
        });
      }
      return Promise.resolve({
        id: "admin-id",
        walletAddress: ADMIN_ADDRESS,
        role: UserRole.ADMIN,
      });
    });
    mockPrisma.failedDispatch.findMany.mockResolvedValue([]);
    mockPrisma.failedDispatch.count.mockResolvedValue(0);
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    app = createApp();
  });

  it("returns the canonical pagination envelope for admins", async () => {
    mockPrisma.failedDispatch.findMany.mockResolvedValueOnce([
      { id: "a", payload: { keep: "1" } },
    ]);
    mockPrisma.failedDispatch.count.mockResolvedValueOnce(5);

    const res = await request(app)
      .get("/api/admin/dead-letter")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({
      limit: 20,
      offset: 0,
      total: 5,
      hasNextPage: false,
    });
    expect(mockPrisma.failedDispatch.findMany.mock.calls[0][0].take).toBe(20);
  });

  it("accepts the max limit of 100 and supports a second page via offset", async () => {
    const res = await request(app)
      .get("/api/admin/dead-letter?limit=100&offset=100")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    const args = mockPrisma.failedDispatch.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
    expect(args.skip).toBe(100);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.pagination.offset).toBe(100);
  });

  it("rejects out-of-range limit with 400", async () => {
    for (const q of ["limit=0", "limit=101", "limit=-1"]) {
      const res = await request(app)
        .get(`/api/admin/dead-letter?${q}`)
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
    }
  });

  it("accepts a lowercase status filter and uppercases it", async () => {
    const res = await request(app)
      .get("/api/admin/dead-letter?status=pending")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.failedDispatch.findMany.mock.calls[0][0].where.status).toBe(
      "PENDING",
    );
  });

  it("exposes a truncation flag for capped payloads", async () => {
    mockPrisma.failedDispatch.findMany.mockResolvedValueOnce([
      {
        id: "trunc",
        payload: { truncated: true, originalBytes: 99_999, preview: "xx" },
      },
      { id: "ok", payload: { keep: "y" } },
    ]);
    mockPrisma.failedDispatch.count.mockResolvedValueOnce(2);

    const res = await request(app)
      .get("/api/admin/dead-letter")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].truncated).toBe(true);
    expect(res.body.data[1].truncated).toBe(false);
  });

  it("requires admin auth", async () => {
    const unauth = await request(app).get("/api/admin/dead-letter");
    expect(unauth.status).toBe(401);

    const forbidden = await request(app)
      .get("/api/admin/dead-letter")
      .set("Authorization", `Bearer ${USER_TOKEN}`);
    expect(forbidden.status).toBe(403);
  });
});
