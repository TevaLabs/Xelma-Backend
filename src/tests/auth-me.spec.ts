/**
 * Issue #965 — GET /api/auth/me is a cheap, authenticated session probe.
 */
import express, { Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { UserRole } from "@prisma/client";
import authRouter from "../routes/auth.routes";
import { generateToken } from "../utils/jwt.util";

const mockUserFindUnique = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
  },
}));

jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn(),
  isValidStellarAddress: jest.fn(),
}));

jest.mock("../middleware/rateLimiter.middleware", () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
  };
});

const USER_ID = "me-test-user-id";
const WALLET = "GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN";
const token = generateToken(USER_ID, WALLET, UserRole.USER);

describe("GET /api/auth/me (#965)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
  });

  it("returns userId, walletAddress, role and exp for a valid session", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: USER_ID,
      walletAddress: WALLET,
      role: UserRole.USER,
    });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: USER_ID,
      walletAddress: WALLET,
      role: UserRole.USER,
    });
    expect(typeof res.body.exp).toBe("number");
    expect(res.body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("No token provided");
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the token cannot be verified", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer not-a-jwt");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
