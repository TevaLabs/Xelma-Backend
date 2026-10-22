/**
 * Tests for PATCH /api/user/profile — input validation and sanitization (Issue #137).
 * Uses mocked Prisma so no database is required.
 */
import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";

const USER_ID = "user-profile-test-id";
const WALLET = "GPROFILE_TEST_USER_WALLET_ADDRESS__________";

const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();
const mockUserFindMany = jest.fn();
const mockUserCount = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
      count: (...args: any[]) => mockUserCount(...args),
    },
    transaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    userStats: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((promises: any) => {
      if (Array.isArray(promises)) return Promise.all(promises);
      if (typeof promises === "function") return promises();
      return Promise.resolve(promises);
    }),
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
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("PATCH /api/user/profile — input validation (Issue #137)", () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    app = createApp();
    token = generateToken(USER_ID, WALLET, UserRole.USER);
  });

  beforeEach(() => {
    mockUserFindUnique.mockResolvedValue({ id: USER_ID, walletAddress: WALLET, role: UserRole.USER });
    mockUserUpdate.mockResolvedValue({ nickname: "validnick", avatarUrl: null, preferences: null });
  });

  // ── Valid requests ────────────────────────────────────────────────────────

  it("accepts a valid nickname update", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "validnick" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("accepts a valid avatarUrl update", async () => {
    mockUserUpdate.mockResolvedValue({ nickname: null, avatarUrl: "https://cdn.example.com/avatar.png", preferences: null });

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatarUrl: "https://cdn.example.com/avatar.png" });

    expect(res.status).toBe(200);
  });

  it("accepts valid preferences", async () => {
    mockUserUpdate.mockResolvedValue({ nickname: null, avatarUrl: null, preferences: { theme: "dark", notifications: true } });

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferences: { theme: "dark", notifications: true } });

    expect(res.status).toBe(200);
  });

  it("accepts all valid fields together", async () => {
    mockUserUpdate.mockResolvedValue({
      nickname: "myuser",
      avatarUrl: "https://cdn.example.com/a.jpg",
      preferences: { theme: "light" },
    });

    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nickname: "myuser",
        avatarUrl: "https://cdn.example.com/a.jpg",
        preferences: { theme: "light" },
      });

    expect(res.status).toBe(200);
  });

  it("trims leading/trailing whitespace from nickname", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "  trimmed  " });

    expect(res.status).toBe(200);
    const updateCall = mockUserUpdate.mock.calls[0][0];
    expect(updateCall.data.nickname).toBe("trimmed");
  });

  // ── Nickname constraints ──────────────────────────────────────────────────

  it("rejects nickname shorter than 2 characters", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "a" });

    expect(res.status).toBe(400);
  });

  it("rejects nickname longer than 30 characters", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "a".repeat(31) });

    expect(res.status).toBe(400);
  });

  it("accepts nickname at exact minimum length (2)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "ab" });

    expect(res.status).toBe(200);
  });

  it("accepts nickname at exact maximum length (30)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "a".repeat(30) });

    expect(res.status).toBe(200);
  });

  it("rejects nickname with disallowed characters (spaces)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "bad nick" });

    expect(res.status).toBe(400);
  });

  it("rejects nickname with special characters (@, !, #)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "bad@nick!" });

    expect(res.status).toBe(400);
  });

  it("accepts nickname with allowed special characters (dot, underscore, hyphen)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "good.nick_user-1" });

    expect(res.status).toBe(200);
  });

  // ── Avatar URL constraints ────────────────────────────────────────────────

  it("rejects avatarUrl that is not a valid URL", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatarUrl: "not-a-url" });

    expect(res.status).toBe(400);
  });

  it("rejects avatarUrl longer than 500 characters", async () => {
    const longUrl = "https://cdn.example.com/" + "a".repeat(480);
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatarUrl: longUrl });

    expect(res.status).toBe(400);
  });

  it("rejects avatarUrl using HTTP (non-HTTPS)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatarUrl: "http://cdn.example.com/avatar.png" });

    expect(res.status).toBe(400);
  });

  // ── Preferences constraints ───────────────────────────────────────────────

  it("rejects unknown fields inside preferences", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferences: { unknownField: true } });

    expect(res.status).toBe(400);
  });

  it("rejects invalid theme value", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferences: { theme: "neon" } });

    expect(res.status).toBe(400);
  });

  it("rejects non-boolean notifications value", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ preferences: { notifications: "yes" } });

    expect(res.status).toBe(400);
  });

  // ── Immutable fields protection ───────────────────────────────────────────

  it("rejects request containing walletAddress field", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "ok", walletAddress: "GHACKED000000" });

    expect(res.status).toBe(400);
  });

  it("rejects request containing id field", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "ok", id: "injected-id" });

    expect(res.status).toBe(400);
  });

  it("rejects request containing role field", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "ok", role: "ADMIN" });

    expect(res.status).toBe(400);
  });

  it("rejects request containing virtualBalance field", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "ok", virtualBalance: 9999999 });

    expect(res.status).toBe(400);
  });

  // ── Empty body ────────────────────────────────────────────────────────────

  it("rejects empty body (no updatable fields provided)", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  // ── Authentication ────────────────────────────────────────────────────────

  it("rejects unauthenticated request with 401", async () => {
    const res = await request(app)
      .patch("/api/user/profile")
      .send({ nickname: "validnick" });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/user/admin/users — list users by role (requireAdmin)", () => {
  let app: Express;
  const adminId = "admin-test-id";
  const adminAddress = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const regularUserId = "regular-test-id";
  const regularUserAddress = "GCWLQSOPFDNVHV657I5EWTEI6TYCDDWNXFGEW4S74WBHOPYANSM767V4";

  const adminToken = generateToken(adminId, adminAddress, UserRole.ADMIN);
  const userToken = generateToken(regularUserId, regularUserAddress, UserRole.USER);

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockUserFindUnique.mockReset();
    mockUserFindMany.mockReset();
    mockUserCount.mockReset();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/user/admin/users");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin users with 403", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: regularUserId,
      walletAddress: regularUserAddress,
      role: UserRole.USER,
    });

    const res = await request(app)
      .get("/api/user/admin/users")
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it("returns 200 and paginated users for admin", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: adminId,
      walletAddress: adminAddress,
      role: UserRole.ADMIN,
    });

    const mockUsers = [
      {
        id: "u-1",
        walletAddress: "GADDR1",
        nickname: "oracle1",
        avatarUrl: null,
        role: UserRole.ORACLE,
        virtualBalance: "1000",
        wins: 5,
        streak: 2,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastLoginAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "u-2",
        walletAddress: "GADDR2",
        nickname: "admin1",
        avatarUrl: null,
        role: UserRole.ADMIN,
        virtualBalance: "2000",
        wins: 10,
        streak: 4,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastLoginAt: null,
      },
    ];

    mockUserFindMany.mockResolvedValueOnce(mockUsers);
    mockUserCount.mockResolvedValueOnce(2);

    const res = await request(app)
      .get("/api/user/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].role).toBe("ORACLE");
    expect(res.body.meta.pagination).toEqual({
      limit: 20,
      offset: 0,
      total: 2,
      totalPages: 1,
    });
  });

  it("filters users by role (e.g. role=ORACLE)", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: adminId,
      walletAddress: adminAddress,
      role: UserRole.ADMIN,
    });

    const mockOracles = [
      {
        id: "u-1",
        walletAddress: "GADDR1",
        nickname: "oracle1",
        avatarUrl: null,
        role: UserRole.ORACLE,
        virtualBalance: "1000",
        wins: 5,
        streak: 2,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastLoginAt: null,
      },
    ];

    mockUserFindMany.mockResolvedValueOnce(mockOracles);
    mockUserCount.mockResolvedValueOnce(1);

    const res = await request(app)
      .get("/api/user/admin/users?role=ORACLE")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].role).toBe("ORACLE");
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: UserRole.ORACLE }),
      }),
    );
  });

  it("supports cursor pagination mode", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: adminId,
      walletAddress: adminAddress,
      role: UserRole.ADMIN,
    });

    const cursorDate = new Date("2026-02-01T00:00:00Z");
    const cursor = Buffer.from(cursorDate.toISOString()).toString("base64url");

    const mockUsers = [
      {
        id: "u-1",
        walletAddress: "GADDR1",
        nickname: "user1",
        avatarUrl: null,
        role: UserRole.ADMIN,
        virtualBalance: "1000",
        wins: 0,
        streak: 0,
        createdAt: new Date("2026-01-15T00:00:00Z"),
        lastLoginAt: null,
      },
    ];

    mockUserFindMany.mockResolvedValueOnce(mockUsers);

    const res = await request(app)
      .get(`/api/user/admin/users?cursor=${cursor}&limit=1`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toHaveProperty("nextCursor");
  });

  it("rejects invalid cursor with 400", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: adminId,
      walletAddress: adminAddress,
      role: UserRole.ADMIN,
    });

    const res = await request(app)
      .get("/api/user/admin/users?cursor=invalid-cursor!")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects invalid role with 400", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: adminId,
      walletAddress: adminAddress,
      role: UserRole.ADMIN,
    });

    const res = await request(app)
      .get("/api/user/admin/users?role=SUPERUSER")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });
});
