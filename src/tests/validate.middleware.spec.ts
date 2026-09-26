import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express, { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.middleware";
import { errorHandler } from "../middleware/errorHandler.middleware";
import { ValidationError } from "../utils/errors";

/**
 * Test suite for validate.middleware
 * Covers safeParse, error handling, malformed JSON, and edge cases
 */
describe("validate middleware", () => {
  let app: Express;

  beforeEach(() => {
    // Create a fresh app for each test
    app = express();
    app.use(express.json());
  });

  describe("valid payloads", () => {
    it("should pass through valid request body", async () => {
      const schema = z.object({ name: z.string(), age: z.number() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json({ received: req.body });
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ name: "Alice", age: 30 });

      expect(res.status).toBe(200);
      expect(res.body.received).toEqual({ name: "Alice", age: 30 });
    });

    it("should pass through valid query parameters", async () => {
      const schema = z.object({ q: z.string(), limit: z.coerce.number().optional() });

      app.get("/test", validate(schema, "query"), (req: Request, res: Response) => {
        res.json({ received: req.query });
      });
      app.use(errorHandler);

      const res = await request(app)
        .get("/test")
        .query({ q: "search", limit: "10" });

      expect(res.status).toBe(200);
      expect(res.body.received).toEqual({ q: "search", limit: 10 });
    });

    it("should pass through valid route parameters", async () => {
      const schema = z.object({ id: z.string().uuid() });

      app.get("/test/:id", validate(schema, "params"), (req: Request, res: Response) => {
        res.json({ received: req.params });
      });
      app.use(errorHandler);

      const id = "550e8400-e29b-41d4-a716-446655440000";
      const res = await request(app).get(`/test/${id}`);

      expect(res.status).toBe(200);
      expect(res.body.received.id).toBe(id);
    });
  });

  describe("invalid payloads", () => {
    it("should return 400 for missing required field", async () => {
      const schema = z.object({ name: z.string(), age: z.number() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ name: "Alice" }); // Missing age

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.message).toBeDefined();
      expect(res.body.details).toBeDefined();
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it("should return 400 for wrong type", async () => {
      const schema = z.object({ age: z.number() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ age: "not a number" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toBeDefined();
    });

    it("should return consistent 4xx error payload without stack trace", async () => {
      const schema = z.object({ email: z.string().email() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ email: "not-an-email" });

      expect(res.status).toBe(400);
      // The full error handler sets `error` to the human-readable message.
      expect(res.body.error).toBe(res.body.message);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.message).toBeDefined();
      expect(res.body.details).toBeDefined();
      // Should not have stack trace in production
      if (process.env.NODE_ENV !== "development") {
        expect(res.body.stack).toBeUndefined();
      }
    });

    it("should include field and message in details", async () => {
      const schema = z.object({
        name: z.string().min(3),
        email: z.string().email(),
      });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ name: "ab", email: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);

      // Each detail should have field and message
      res.body.details.forEach((detail: any) => {
        expect(detail).toHaveProperty("field");
        expect(detail).toHaveProperty("message");
        expect(typeof detail.field).toBe("string");
        expect(typeof detail.message).toBe("string");
      });
    });
  });

  describe("malformed JSON and edge cases", () => {
    it("should handle malformed JSON gracefully", async () => {
      const schema = z.object({ name: z.string() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .set("Content-Type", "application/json")
        .send("{invalid json"); // Malformed

      expect(res.status).toBe(400); // Should be 400 from express.json() middleware
      // The error should be caught somewhere in the chain
      expect([400, 413]).toContain(res.status);
    });

    it("should handle empty body", async () => {
      const schema = z.object({ name: z.string() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app).post("/test").send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should handle null values", async () => {
      const schema = z.object({ name: z.string() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ name: null });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should handle extra fields (strict schema)", async () => {
      const schema = z.object({ name: z.string() }).strict();

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ name: "Alice", extraField: "not allowed" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should handle deeply nested validation errors", async () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            email: z.string().email(),
          }),
        }),
      });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        res.json(req.body);
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ user: { profile: { email: "not-email" } } });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toBeDefined();
    });
  });

  describe("existing route behavior", () => {
    it("should not affect valid request handling", async () => {
      const schema = z.object({ count: z.number().positive() });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        const result = req.body.count * 2;
        res.json({ result });
      });
      app.use(errorHandler);

      const res = await request(app)
        .post("/test")
        .send({ count: 5 });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(10);
    });

    it("should not modify valid request data", async () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      app.post("/test", validate(schema, "body"), (req: Request, res: Response) => {
        // req.body should be replaced with validated data
        res.json(req.body);
      });
      app.use(errorHandler);

      const payload = { name: "Bob", age: 25 };
      const res = await request(app)
        .post("/test")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
    });
  });
});
