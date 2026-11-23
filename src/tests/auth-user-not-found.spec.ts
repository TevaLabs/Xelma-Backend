/**
 * Issue #969 — fail closed when a JWT is valid but its user row is gone.
 *
 * A signed token only proves the subject existed at login time. Once the user
 * is deleted, `authenticateUser` (and every role-gated sibling) must answer
 * 401 `AUTH_USER_NOT_FOUND` instead of letting the stale token keep acting.
 */
import express, { Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { UserRole } from "@prisma/client";
import { authenticateUser } from "../middleware/auth.middleware";
import { generateToken } from "../utils/jwt.util";
import { ErrorCode } from "../utils/errors";

const mockUserFindUnique = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
  },
}));

const WALLET = "GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN";
const USER_ID = "deleted-user-id";

const token = generateToken(USER_ID, WALLET, UserRole.USER);

describe("authenticateUser — deleted user with a valid JWT (#969)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.get("/protected", authenticateUser, (req, res) => {
      res.status(200).json({ user: req.user });
    });
  });

  it("returns 401 AUTH_USER_NOT_FOUND when the token is valid but the row is gone", async () => {
    mockUserFindUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.AUTH_USER_NOT_FOUND);
    expect(res.body.error).toBe("User not found");
    // The raw token must never be echoed back.
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("still authenticates when the user row exists", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: USER_ID,
      walletAddress: WALLET,
      role: UserRole.USER,
    });

    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      userId: USER_ID,
      walletAddress: WALLET,
      role: UserRole.USER,
    });
  });

  it("keeps the generic invalid-token response for unverifiable tokens", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer not-a-jwt");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
    expect(res.body.code).toBeUndefined();
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the missing-token response when no Authorization header is sent", async () => {
    const res = await request(app).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("No token provided");
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
