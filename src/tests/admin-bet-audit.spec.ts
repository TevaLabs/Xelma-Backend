import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { betAuditService } from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";

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
}));

const mockPrisma = prisma as any;

// Preflight (src/config/preflight.ts) enforces a 16+ char JWT_SECRET (#438).
// Set a long, stable value and build the app AFTER it (in beforeAll) so the
// same secret is used for signing, preflight, and verification. Building the
// app per-test with jest.resetModules() would also reset the jest.mock
// factories above, breaking the prisma stubs the auth middleware relies on.
const ADMIN_TEST_JWT_SECRET = "admin-bet-audit-test-secret-1234567890";

describe("Admin Bet-Audit Endpoint (Issue #426)", () => {
  let app: Express;
  const ADMIN_ADDRESS = "GADMIN_TEST_AAAAAAAAAAAAAAAAAAAAAAAA";
  const USER_ADDRESS = "GUSER_TEST_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  let ADMIN_TOKEN: string;
  let USER_TOKEN: string;

  beforeAll(() => {
    process.env.JWT_SECRET = ADMIN_TEST_JWT_SECRET;
    app = require("../index").createApp();
    ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
    USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);
  });

  beforeEach(() => {
    betAuditService.clear();
    jest.clearAllMocks();
    betAuditService.emitBetAccepted({
      address: USER_ADDRESS,
      amount: 100,
      side: "UP",
      mode: "UP_DOWN",
      result: "stub",
    });
    betAuditService.emitBetAccepted({
      address: ADMIN_ADDRESS,
      amount: 200,
      side: "DOWN",
      mode: "UP_DOWN",
      result: "on-chain-success",
      txHash: "0xabc123def456ghi789jkl012mno345pqr678stu901vwx234",
    });
    betAuditService.emitBetAccepted({
      address: USER_ADDRESS,
      amount: 50,
      mode: "PRECISION",
      result: "stub",
      txHash: "0xf1e2d3c4b5a697887766554433221100ffeeddccbbaa99",
    });

    // Return the role that matches each token's subject so admin and
    // non-admin paths are both exercised.
    mockPrisma.user.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === "user-id") {
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
  });

  afterEach(() => {
    betAuditService.clear();
  });

  it("returns 200 with events for admin users", async () => {
    const res = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("events");
    expect(res.body).toHaveProperty("total");
    expect(res.body.total).toBeLessThanOrEqual(3);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(403);
  });

  it("returns 401 when no token is provided", async () => {
    const res = await request(app).get("/api/admin/bet-audit");
    expect(res.status).toBe(401);
  });

  it("filters events by address query param", async () => {
    const res = await request(app)
      .get(`/api/admin/bet-audit?address=${encodeURIComponent(USER_ADDRESS)}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    res.body.events.forEach((event: any) => {
      expect(event.address).toBe(USER_ADDRESS);
    });
  });

  it("respects the limit query param", async () => {
    const res = await request(app)
      .get("/api/admin/bet-audit?limit=1")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(1);
  });

  it("caps limit at 100", async () => {
    const res = await request(app)
      .get("/api/admin/bet-audit?limit=9999")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(100);
  });

  it("redacts txHash in event output", async () => {
    const res = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    const txHashEvents = res.body.events.filter(
      (e: any) => e.txHash !== undefined,
    );
    txHashEvents.forEach((event: any) => {
      expect(event.txHash).toMatch(/^\w{8}\.\.\.$/);
    });
  });

  it("returns 500 when service throws", async () => {
    jest.spyOn(betAuditService, "queryEvents").mockImplementation(() => {
      throw new Error("Simulated failure");
    });

    const res = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});