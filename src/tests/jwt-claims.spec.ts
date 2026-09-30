import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { generateToken, verifyToken, verifyTokenDetailed } from "../utils/jwt.util";

describe("JWT Issuer and Audience Claims (Issue #687)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: "test-secret-key-12345",
      JWT_ISSUER: "xelma.io",
      JWT_AUDIENCE: "xelma.io",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should generate tokens with iss and aud claims and verify them successfully", () => {
    const token = generateToken("user-123", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", UserRole.USER);

    const decoded = jwt.decode(token) as any;
    expect(decoded).toHaveProperty("iss", "xelma.io");
    expect(decoded).toHaveProperty("aud", "xelma.io");
    expect(decoded).toHaveProperty("userId", "user-123");

    const verified = verifyToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe("user-123");
  });

  it("should reject tokens generated with mismatched issuer", () => {
    const wrongToken = jwt.sign(
      { userId: "user-123", walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", role: UserRole.USER },
      "test-secret-key-12345",
      { issuer: "other-issuer.com", audience: "xelma.io" }
    );

    const verified = verifyToken(wrongToken);
    expect(verified).toBeNull();

    const detailed = verifyTokenDetailed(wrongToken);
    expect(detailed.valid).toBe(false);
    expect(detailed.expired).toBe(false);
  });

  it("should reject tokens generated with mismatched audience", () => {
    const wrongToken = jwt.sign(
      { userId: "user-123", walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", role: UserRole.USER },
      "test-secret-key-12345",
      { issuer: "xelma.io", audience: "other-audience.com" }
    );

    const verified = verifyToken(wrongToken);
    expect(verified).toBeNull();

    const detailed = verifyTokenDetailed(wrongToken);
    expect(detailed.valid).toBe(false);
    expect(detailed.expired).toBe(false);
  });

  it("should support token generation and verification when issuer/audience are unset", () => {
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;

    const token = generateToken("user-456", "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", UserRole.USER);
    const verified = verifyToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe("user-456");
  });
});
