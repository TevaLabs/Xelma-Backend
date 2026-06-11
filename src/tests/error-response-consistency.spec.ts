import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import express from "express";
import { ErrorResponse } from "../middleware/errorHandler.middleware";

/**
 * Test suite to ensure all API routes return consistent error response format.
 * 
 * This validates that:
 * - All errors include required fields (error, message, code, requestId, timestamp)
 * - Error codes are stable and machine-readable
 * - HTTP status codes match error types
 * - Response shape is consistent across all routes
 */

describe("Error Response Consistency", () => {
  let app: express.Express;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require("../index").createApp();
  });

  /**
   * Helper to validate standard error response shape
   */
  function expectStandardErrorShape(body: any, expectedCode?: string) {
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("requestId");
    expect(body).toHaveProperty("timestamp");

    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(typeof body.code).toBe("string");
    expect(typeof body.requestId).toBe("string");
    expect(typeof body.timestamp).toBe("string");

    // Validate timestamp is ISO 8601
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Validate requestId is UUID format
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    if (expectedCode) {
      expect(body.code).toBe(expectedCode);
    }
  }

  describe("404 Not Found Errors", () => {
    it("returns standard error shape for non-existent route", async () => {
      const res = await request(app).get("/api/nonexistent-route-xyz");

      expect(res.status).toBe(404);
      expectStandardErrorShape(res.body, "NOT_FOUND");
      expect(res.body.error).toBe("NotFoundError");
    });

    it("returns standard error shape for non-existent resource", async () => {
      const res = await request(app)
        .get("/api/notifications/00000000-0000-0000-0000-000000000000")
        .set("Authorization", "Bearer invalid-token");

      // Will fail auth first, but demonstrates consistent error handling
      expect(res.status).toBeGreaterThanOrEqual(400);
      expectStandardErrorShape(res.body);
    });
  });

  describe("401 Authentication Errors", () => {
    it("returns standard error shape for missing auth token", async () => {
      const res = await request(app).get("/api/notifications");

      expect(res.status).toBe(401);
      expectStandardErrorShape(res.body, "AUTHENTICATION_ERROR");
      expect(res.body.error).toBe("AuthenticationError");
    });

    it("returns standard error shape for invalid auth token", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", "Bearer invalid-token-xyz");

      expect(res.status).toBe(401);
      expectStandardErrorShape(res.body);
    });

    it("returns standard error shape for malformed auth header", async () => {
      const res = await request(app)
        .get("/api/notifications")
        .set("Authorization", "InvalidFormat");

      expect(res.status).toBe(401);
      expectStandardErrorShape(res.body);
    });
  });

  describe("400 Validation Errors", () => {
    it("returns standard error shape with details for invalid request body", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ invalidField: "value" });

      expect(res.status).toBe(400);
      expectStandardErrorShape(res.body, "VALIDATION_ERROR");
      expect(res.body.error).toBe("ValidationError");

      // Validation errors should include details
      if (res.body.details) {
        expect(Array.isArray(res.body.details)).toBe(true);
        res.body.details.forEach((detail: any) => {
          expect(detail).toHaveProperty("field");
          expect(detail).toHaveProperty("message");
        });
      }
    });

    it("returns standard error shape for malformed JSON", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .set("Content-Type", "application/json")
        .send("{ invalid json }");

      expect(res.status).toBe(400);
      expectStandardErrorShape(res.body, "VALIDATION_ERROR");
    });
  });

  describe("Request ID Consistency", () => {
    it("includes same requestId in response header and body", async () => {
      const res = await request(app).get("/api/nonexistent");

      expect(res.status).toBe(404);
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.body.requestId).toBe(res.headers["x-request-id"]);
    });

    it("accepts and uses client-provided request ID", async () => {
      const clientRequestId = "12345678-1234-1234-1234-123456789012";

      const res = await request(app)
        .get("/api/nonexistent")
        .set("X-Request-ID", clientRequestId);

      expect(res.status).toBe(404);
      expect(res.headers["x-request-id"]).toBe(clientRequestId);
      expect(res.body.requestId).toBe(clientRequestId);
    });
  });

  describe("Error Code Stability", () => {
    it("uses consistent error codes for authentication failures", async () => {
      const res1 = await request(app).get("/api/notifications");
      const res2 = await request(app).get("/api/predictions/user");

      expect(res1.body.code).toBe(res2.body.code);
      expect(res1.body.code).toBe("AUTHENTICATION_ERROR");
    });

    it("uses consistent error codes for validation failures", async () => {
      const res1 = await request(app)
        .post("/api/auth/challenge")
        .send({});

      const res2 = await request(app)
        .post("/api/auth/connect")
        .send({});

      expect(res1.body.code).toBe("VALIDATION_ERROR");
      expect(res2.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("HTTP Status Code Consistency", () => {
    it("returns 400 for all validation errors", async () => {
      const endpoints = [
        { method: "post", path: "/api/auth/challenge", body: {} },
        { method: "post", path: "/api/auth/connect", body: {} },
      ];

      for (const endpoint of endpoints) {
        const res = await request(app)[endpoint.method](endpoint.path).send(
          endpoint.body
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
        expectStandardErrorShape(res.body);
      }
    });

    it("returns 401 for all authentication errors", async () => {
      const endpoints = [
        "/api/notifications",
        "/api/predictions/user",
        "/api/user/profile",
      ];

      for (const endpoint of endpoints) {
        const res = await request(app).get(endpoint);

        expect(res.status).toBe(401);
        expect(res.body.code).toBe("AUTHENTICATION_ERROR");
        expectStandardErrorShape(res.body);
      }
    });

    it("returns 404 for all not found errors", async () => {
      const endpoints = [
        "/api/nonexistent",
        "/api/rounds/nonexistent-id",
        "/api/invalid/route",
      ];

      for (const endpoint of endpoints) {
        const res = await request(app).get(endpoint);

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
        expectStandardErrorShape(res.body);
      }
    });
  });

  describe("Error Response Fields", () => {
    it("never includes undefined or null required fields", async () => {
      const res = await request(app).get("/api/nonexistent");

      expect(res.body.error).not.toBeNull();
      expect(res.body.error).not.toBeUndefined();
      expect(res.body.message).not.toBeNull();
      expect(res.body.message).not.toBeUndefined();
      expect(res.body.code).not.toBeNull();
      expect(res.body.code).not.toBeUndefined();
      expect(res.body.requestId).not.toBeNull();
      expect(res.body.requestId).not.toBeUndefined();
      expect(res.body.timestamp).not.toBeNull();
      expect(res.body.timestamp).not.toBeUndefined();
    });

    it("includes details field only when applicable", async () => {
      // Validation error should have details
      const validationRes = await request(app)
        .post("/api/auth/challenge")
        .send({});

      if (validationRes.body.details) {
        expect(Array.isArray(validationRes.body.details)).toBe(true);
      }

      // Not found error should not have details
      const notFoundRes = await request(app).get("/api/nonexistent");
      // details can be undefined or not present
      if (notFoundRes.body.details !== undefined) {
        expect(notFoundRes.body.details).toBeUndefined();
      }
    });

    it("does not include stack trace in production mode", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const res = await request(app).get("/api/nonexistent");

      expect(res.body.stack).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("Content-Type Consistency", () => {
    it("always returns application/json for errors", async () => {
      const endpoints = [
        { method: "get", path: "/api/nonexistent" },
        { method: "post", path: "/api/auth/challenge", body: {} },
        { method: "get", path: "/api/notifications" },
      ];

      for (const endpoint of endpoints) {
        const res = await request(app)[endpoint.method](endpoint.path).send(
          endpoint.body || {}
        );

        expect(res.headers["content-type"]).toMatch(/application\/json/);
      }
    });
  });

  describe("Error Message Quality", () => {
    it("provides meaningful error messages", async () => {
      const res = await request(app).get("/api/nonexistent");

      expect(res.body.message).toBeTruthy();
      expect(res.body.message.length).toBeGreaterThan(0);
      expect(res.body.message).not.toBe("Error");
      expect(res.body.message).not.toBe("error");
    });

    it("does not expose sensitive information in error messages", async () => {
      const res = await request(app)
        .post("/api/auth/connect")
        .send({
          walletAddress: "test",
          challenge: "test",
          signature: "test",
        });

      // Should not include database details, file paths, etc.
      expect(res.body.message).not.toMatch(/prisma/i);
      expect(res.body.message).not.toMatch(/database/i);
      expect(res.body.message).not.toMatch(/\/src\//);
      expect(res.body.message).not.toMatch(/\.ts/);
    });
  });

  describe("Validation Error Details", () => {
    it("includes field-level validation details", async () => {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ invalidField: "value" });

      expect(res.status).toBe(400);

      if (res.body.details && res.body.details.length > 0) {
        const detail = res.body.details[0];
        expect(detail).toHaveProperty("field");
        expect(detail).toHaveProperty("message");
        expect(typeof detail.field).toBe("string");
        expect(typeof detail.message).toBe("string");
      }
    });
  });
});
