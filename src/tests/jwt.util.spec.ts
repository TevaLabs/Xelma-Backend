import { describe, it, expect } from "@jest/globals";
import { generateToken, verifyToken } from "../utils/jwt.util";
import { parseJwtExpiry } from "../config/jwt-expiry";
import jwt from "jsonwebtoken";

/**
 * Test suite for JWT utilities
 * Verifies safe token verification and removal of unsafe decode
 */
describe("JWT utilities", () => {
  const testUserId = "test-user-123";
  const testWalletAddress = "GABC123...";
  const testRole = "USER";

  describe("JWT expiry parsing", () => {
    it("preserves valid duration strings", () => {
      expect(parseJwtExpiry("7d")).toBe("7d");
    });

    it("parses integer environment values as seconds", () => {
      expect(parseJwtExpiry("3600")).toBe(3600);
    });

    it.each(["forever", "7 days-ish", "0", "0s", "1e3"])(
      "rejects invalid expiry value %s",
      (expiry) => {
        expect(() => parseJwtExpiry(expiry)).toThrow(/JWT_EXPIRY must be/);
      },
    );
  });

  beforeEach(() => {
    // Ensure JWT_SECRET is set
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = "test-jwt-secret";
    }
  });

  describe("generateToken", () => {
    it("should generate a valid JWT token", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3); // JWT has 3 parts
    });

    it("should include payload data in token", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      const decoded: any = jwt.decode(token);
      expect(decoded.userId).toBe(testUserId);
      expect(decoded.walletAddress).toBe(testWalletAddress);
      expect(decoded.role).toBe(testRole);
    });
  });

  describe("verifyToken", () => {
    it("should verify and decode valid token", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      const decoded = verifyToken(token);

      expect(decoded).toBeDefined();
      expect(decoded?.userId).toBe(testUserId);
      expect(decoded?.walletAddress).toBe(testWalletAddress);
      expect(decoded?.role).toBe(testRole);
    });

    it("should return null for invalid signature", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      // Modify the token to invalidate signature
      const parts = token.split(".");
      const tamperedToken = parts[0] + "." + parts[1] + ".invalidsignature";

      const decoded = verifyToken(tamperedToken);

      expect(decoded).toBeNull();
    });

    it("should return null for expired token", () => {
      const originalExpiry = process.env.JWT_EXPIRY;
      process.env.JWT_EXPIRY = "1ms";

      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      // Wait a bit to ensure token is expired
      return new Promise((resolve) => {
        setTimeout(() => {
          const decoded = verifyToken(token);
          if (originalExpiry === undefined) {
            delete process.env.JWT_EXPIRY;
          } else {
            process.env.JWT_EXPIRY = originalExpiry;
          }
          expect(decoded).toBeNull();
          resolve(null);
        }, 100);
      });
    });

    it("should return null for malformed token", () => {
      const decoded = verifyToken("not.a.valid.token");
      expect(decoded).toBeNull();
    });

    it("should return null for empty token", () => {
      const decoded = verifyToken("");
      expect(decoded).toBeNull();
    });

    it("should return null for token with wrong secret", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      // Change the secret
      const originalSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = "different-secret";

      const decoded = verifyToken(token);

      // Restore original secret
      process.env.JWT_SECRET = originalSecret;

      expect(decoded).toBeNull();
    });
  });

  describe("unsafe decodeToken removal", () => {
    it("should not export decodeToken function", () => {
      // Import the module and check if decodeToken is exported
      const jwtModule = require("../utils/jwt.util");

      expect(jwtModule.decodeToken).toBeUndefined();
    });

    it("should only export generateToken and verifyToken", () => {
      const jwtModule = require("../utils/jwt.util");

      const exportedFunctions = Object.keys(jwtModule).filter(
        (key) => typeof jwtModule[key] === "function"
      );

      expect(exportedFunctions).toContain("generateToken");
      expect(exportedFunctions).toContain("verifyToken");
      expect(exportedFunctions).not.toContain("decodeToken");
    });
  });

  describe("signature verification security", () => {
    it("verifyToken should reject tokens with modified payload", () => {
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      const parts = token.split(".");
      const decodedPayload = JSON.parse(
        Buffer.from(parts[1], "base64").toString()
      );

      // Modify the payload
      decodedPayload.userId = "different-user";
      const modifiedPayload = Buffer.from(
        JSON.stringify(decodedPayload)
      ).toString("base64");

      const tamperedToken = parts[0] + "." + modifiedPayload + "." + parts[2];

      const decoded = verifyToken(tamperedToken);

      expect(decoded).toBeNull();
    });

    it("verifyToken should never accept unsigned or unverified tokens", () => {
      // Attempt to use jwt.decode (if accessible via globals or require)
      const testPayload = {
        userId: testUserId,
        walletAddress: testWalletAddress,
        role: testRole,
      };

      // Create an unsigned token manually
      const unsignedToken = (
        Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
          "base64"
        ) +
        "." +
        Buffer.from(JSON.stringify(testPayload)).toString("base64") +
        ".none"
      ).replace(/=/g, "");

      const decoded = verifyToken(unsignedToken);

      expect(decoded).toBeNull();
    });
  });

  describe("JWT lifecycle", () => {
    it("should complete full auth flow securely", () => {
      // Generate a token
      const token = generateToken(testUserId, testWalletAddress, testRole as any);

      // Verify it once
      const firstVerify = verifyToken(token);
      expect(firstVerify).toBeDefined();

      // Verify it again (should work multiple times)
      const secondVerify = verifyToken(token);
      expect(secondVerify).toBeDefined();

      // Both verifications should have same data
      expect(firstVerify?.userId).toBe(secondVerify?.userId);
    });
  });
});
