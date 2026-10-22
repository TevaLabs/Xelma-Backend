import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const findUnique = jest.fn<(args: unknown) => Promise<unknown>>();
const verifyToken = jest.fn<(token: string) => unknown>();

jest.mock("../lib/prisma", () => ({ prisma: { user: { findUnique } } }));
jest.mock("../utils/jwt.util", () => ({ verifyToken }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  authenticateUser,
  optionalAuthentication,
  AUTH_USER_NOT_FOUND,
} from "../middleware/auth.middleware";

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const req = () => ({ headers: { authorization: "Bearer token" } }) as any;

describe("auth middleware: JWT user row missing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 AUTH_USER_NOT_FOUND for a valid token whose user was deleted", async () => {
    verifyToken.mockReturnValue({ userId: "u1", walletAddress: "GA" });
    findUnique.mockResolvedValue(null);
    const res = mockRes();
    const next = jest.fn();

    await authenticateUser(req(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "User not found",
      code: AUTH_USER_NOT_FOUND,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the generic 401 for an invalid token", async () => {
    verifyToken.mockReturnValue(null);
    const res = mockRes();

    await authenticateUser(req(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid or expired token" });
  });

  it("lets optionalAuthentication continue unauthenticated when the user is missing", async () => {
    verifyToken.mockReturnValue({ userId: "u1", walletAddress: "GA" });
    findUnique.mockResolvedValue(null);
    const r = req();
    const next = jest.fn();

    await optionalAuthentication(r, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(r.user).toBeUndefined();
  });
});
