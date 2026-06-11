import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  BusinessRuleError,
  ExternalServiceError,
} from "../utils/errors";
import { errorHandler } from "../middleware/errorHandler.middleware";
import { requestIdMiddleware } from "../middleware/requestId.middleware";

/** Build a minimal Express app with one route that throws the given error */
function makeApp(thrower: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get("/test", thrower);
  app.use(errorHandler);
  return app;
}

describe("AppError subclasses", () => {
  it("ValidationError has statusCode 400 and code VALIDATION_ERROR", () => {
    const err = new ValidationError("bad input");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("bad input");
  });

  it("ValidationError carries details", () => {
    const details = [{ field: "email", message: "required" }];
    const err = new ValidationError("invalid", details);
    expect(err.details).toEqual(details);
  });

  it("AuthenticationError has statusCode 401", () => {
    const err = new AuthenticationError("not logged in");
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("AUTHENTICATION_ERROR");
  });

  it("AuthorizationError has statusCode 403", () => {
    const err = new AuthorizationError("forbidden");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("AUTHORIZATION_ERROR");
  });

  it("NotFoundError has statusCode 404", () => {
    const err = new NotFoundError("not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("ConflictError has statusCode 409 and custom code", () => {
    const err = new ConflictError("duplicate", "ACTIVE_ROUND_EXISTS");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("ACTIVE_ROUND_EXISTS");
  });

  it("BusinessRuleError has statusCode 422", () => {
    const err = new BusinessRuleError("invalid state");
    expect(err.statusCode).toBe(422);
  });

  it("ExternalServiceError has statusCode 503", () => {
    const err = new ExternalServiceError("oracle down");
    expect(err.statusCode).toBe(503);
  });

  it("AppError instances are instanceof AppError", () => {
    expect(new ValidationError("x")).toBeInstanceOf(AppError);
    expect(new NotFoundError("x")).toBeInstanceOf(AppError);
    expect(new ConflictError("x")).toBeInstanceOf(AppError);
  });
});

describe("errorHandler middleware", () => {
  it("maps ValidationError to 400 with correct shape", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new ValidationError("bad input", [{ field: "name", message: "required" }]))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.message).toBe("bad input");
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toEqual([{ field: "name", message: "required" }]);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it("maps AuthenticationError to 401", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new AuthenticationError("invalid token"))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("AuthenticationError");
    expect(res.body.code).toBe("AUTHENTICATION_ERROR");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("maps AuthorizationError to 403", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new AuthorizationError("admin only"))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("AUTHORIZATION_ERROR");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("maps NotFoundError to 404", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new NotFoundError("round not found"))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("round not found");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("maps ConflictError with custom code to 409", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new ConflictError("round exists", "ACTIVE_ROUND_EXISTS"))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACTIVE_ROUND_EXISTS");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("maps unknown Error to 500 with INTERNAL_SERVER_ERROR code", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new Error("something blew up"))
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.message).toBe("something blew up");
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it("responds with JSON content-type", async () => {
    const app = makeApp((_req, _res, next) => next(new NotFoundError("x")));

    const res = await request(app).get("/test");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("includes requestId in response header", async () => {
    const app = makeApp((_req, _res, next) => next(new NotFoundError("x")));

    const res = await request(app).get("/test");
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it("includes timestamp in ISO 8601 format", async () => {
    const app = makeApp((_req, _res, next) => next(new NotFoundError("x")));

    const res = await request(app).get("/test");
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("does not include stack in production mode", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = makeApp((_req, _res, next) =>
      next(new Error("boom"))
    );

    const res = await request(app).get("/test");
    expect(res.body.stack).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });
});

describe("errorHandler via createApp routes", () => {
  // Import createApp lazily to use the real app with all routes mounted
  let app: express.Express;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require("../index").createApp();
  });

  it.skip("404 handler returns structured NotFoundError shape", async () => {
    const res = await request(app).get("/api/nonexistent-route-xyz");
    
    // Basic assertions
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("code");
    expect(res.body).toHaveProperty("message");
    expect(res.body).toHaveProperty("requestId");
    expect(res.body).toHaveProperty("timestamp");
    
    // Specific values
    expect(res.body.error).toBe("NotFoundError");
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
