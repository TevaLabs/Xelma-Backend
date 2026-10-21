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
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockPrisma = prisma as any;
const TEST_JWT_SECRET = "admin-cors-diagnostics-test-jwt-secret-2026-x";
process.env.JWT_SECRET = TEST_JWT_SECRET;

describe("Admin CORS Diagnostics Endpoint (#885)", () => {
  let app: Express;
  const ADMIN_ADDRESS = "GADMIN_TEST_AAAAAAAAAAAAAAAAAAAAAAAA";
  const USER_ADDRESS = "GUSER_TEST_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  let ADMIN_TOKEN: string;
  let USER_TOKEN: string;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.CLIENT_URL = "https://app.example.com";
    process.env.ALLOWED_ORIGINS = "https://staging.example.com";
    process.env.ENABLE_CORS_DIAGNOSTICS = "true";

    ADMIN_TOKEN = generateToken("admin-id", ADMIN_ADDRESS, UserRole.ADMIN);
    USER_TOKEN = generateToken("user-id", USER_ADDRESS, UserRole.USER);

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

    app = createApp();
  });

  it("returns 200 with http and socket CORS configurations for admin users", async () => {
    const res = await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("env");
    expect(res.body).toHaveProperty("http");
    expect(res.body).toHaveProperty("socket");

    expect(res.body.http).toEqual({
      allowAll: false,
      origins: ["https://app.example.com", "https://staging.example.com"],
    });

    expect(res.body.socket).toEqual({
      allowAll: false,
      origins: ["https://app.example.com", "https://staging.example.com"],
      methods: ["GET", "POST"],
      credentials: true,
    });
  });

  it("evaluates test origin against both http and socket allowlists", async () => {
    const res = await request(app)
      .get("/api/admin/cors-diagnostics?origin=https://app.example.com")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.test).toEqual({
      origin: "https://app.example.com",
      httpAllowed: true,
      socketAllowed: true,
    });
  });

  it("returns 403 for non-admin users", async () => {
    const res = await request(app)
      .get("/api/admin/cors-diagnostics")
      .set("Authorization", `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(403);
  });
});
