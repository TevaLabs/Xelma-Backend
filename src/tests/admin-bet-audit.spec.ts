import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { betAuditService } from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";
import { createApp } from "../index";

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(), findMany: jest.fn() },
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockPrisma = prisma as any;

// Preflight (full mode) requires JWT_SECRET >= 16 chars, and auth middleware
// verifies tokens against process.env.JWT_SECRET at request time. Set one
// value BEFORE generateToken() runs so tokens and verification agree.
const TEST_JWT_SECRET = "admin-bet-audit-test-jwt-secret-2026-x";
process.env.JWT_SECRET = TEST_JWT_SECRET;

describe("Admin Bet-Audit Endpoint (Issue #426)", () => {
  let app: Express;
  const ADMIN_ADDRESS = "GADMIN_TEST_AAAAAAAAAAAAAAAAAAAAAAAA";
  const USER_ADDRESS = "GUSER_TEST_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
  const USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);

  beforeEach(() => {
    betAuditService.clear();
    jest.restoreAllMocks();
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

    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      const id = args?.where?.id ?? args?.where?.walletAddress;
      if (id === USER_ADDRESS || id === "user-id") {
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

    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    app = createApp();
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
    jest.spyOn(betAuditService, "queryStoredEvents").mockImplementation(async () => {
      throw new Error("Simulated failure");
    });

    const res = await request(app)
      .get("/api/admin/bet-audit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

describe.each(["memory", "database"] as const)(
  "Bet-audit storage contract (%s mode)",
  (storageMode) => {
    let originalStorage: string | undefined;

    beforeEach(() => {
      originalStorage = process.env.BET_AUDIT_STORAGE;
      process.env.BET_AUDIT_STORAGE = storageMode;
      betAuditService.clear();
      app = createApp();
    });

    afterEach(() => {
      if (originalStorage === undefined) {
        delete process.env.BET_AUDIT_STORAGE;
      } else {
        process.env.BET_AUDIT_STORAGE = originalStorage;
      }
      betAuditService.clear();
    });

    it("returns the exact structured audit payload through the tracking route", async () => {
      const createdAt = "2026-09-25T12:00:00.000Z";
      const payload = {
        betId: "bet-contract-529",
        address: USER_ADDRESS,
        amount: 123.45,
        side: "DOWN" as const,
        mode: "UP_DOWN" as const,
        result: "on-chain-success",
        status: "CONFIRMED" as const,
        txHash: "0x1234567890abcdef",
        requestId: "request-529",
        correlationId: "request-529:0x1234567890abcdef",
      };

      if (storageMode === "database") {
        mockPrisma.auditLog.findMany.mockResolvedValue([
          {
            eventType: "BET_ACCEPTED",
            outcome: "success",
            walletAddress: USER_ADDRESS,
            requestId: payload.requestId,
            timestamp: createdAt,
            metadata: payload,
          },
        ]);
      }

      const emitted = betAuditService.emitBetAccepted(payload);
      if (storageMode === "database") {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const res = await request(app)
        .get(`/api/admin/bet-audit?address=${encodeURIComponent(USER_ADDRESS)}`)
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        betId: payload.betId,
        address: payload.address,
        amount: payload.amount,
        side: payload.side,
        mode: payload.mode,
        result: payload.result,
        status: payload.status,
        requestId: payload.requestId,
        correlationId: payload.correlationId,
        txHash: "0x123456...",
        createdAt: storageMode === "database" ? createdAt : emitted.createdAt,
      });

      if (storageMode === "memory") {
        expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
      } else {
        expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
          where: {
            eventType: {
              in: ["BET_ACCEPTED", "BET_FAILED", "BET_RECONCILED", "CLAIM_ACCEPTED"],
            },
            walletAddress: USER_ADDRESS,
          },
          orderBy: { timestamp: "desc" },
          take: 50,
        });
        expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              walletAddress: USER_ADDRESS,
              metadata: expect.objectContaining({
                amount: payload.amount,
                side: payload.side,
                mode: payload.mode,
                txHash: payload.txHash,
              }),
            }),
          }),
        );
      }
    });

    it.each([
      ["without a token", undefined, 401],
      ["with a non-admin token", USER_TOKEN, 403],
    ])("rejects %s", async (_description, token, expectedStatus) => {
      const req = request(app).get("/api/admin/bet-audit");
      if (token) {
        req.set("Authorization", `Bearer ${token}`);
      }

      const res = await req;

      expect(res.status).toBe(expectedStatus);
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
    });
  },
);
});