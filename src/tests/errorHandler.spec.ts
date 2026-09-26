import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
} from "@prisma/client/runtime/library";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  BusinessRuleError,
  ExternalServiceError,
  BackpressureError,
} from "../utils/errors";
import { CircuitBreakerOpenError } from "../utils/circuit-breaker";
import { errorHandler } from "../middleware/errorHandler.middleware";
import { requestIdMiddleware } from "../middleware/requestId.middleware";

function prismaKnownError(
  code: string,
  meta?: Record<string, unknown>,
): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError(`Prisma ${code}`, {
    code,
    clientVersion: "test",
    meta,
  });
}

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

describe("errorHandler Prisma mapping", () => {
  it("maps P2025 to 404 NOT_FOUND", async () => {
    const app = makeApp((_req, _res, next) =>
      next(prismaKnownError("P2025", { cause: "User not found" })),
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(res.body.message).toBe("User not found");
    expect(res.body.path).toBe("/test");
  });

  it("maps P2025 without meta.cause to default message", async () => {
    const app = makeApp((_req, _res, next) => next(prismaKnownError("P2025")));

    const res = await request(app).get("/test");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Record not found");
  });

  it("maps P2002 to 409 CONFLICT with target fields", async () => {
    const app = makeApp((_req, _res, next) =>
      next(prismaKnownError("P2002", { target: ["email", "wallet"] })),
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.message).toBe("Unique constraint failed on: email, wallet");
  });

  it("maps P2003 to 400 FOREIGN_KEY_VIOLATION", async () => {
    const app = makeApp((_req, _res, next) => next(prismaKnownError("P2003")));

    const res = await request(app).get("/test");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FOREIGN_KEY_VIOLATION");
    expect(res.body.message).toBe("Related record not found");
  });

  it("maps unknown Prisma known-request codes to 500", async () => {
    const app = makeApp((_req, _res, next) => next(prismaKnownError("P9999")));

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.message).toBe("Database error");
  });

  it("maps PrismaClientValidationError to 400 VALIDATION_ERROR", async () => {
    const app = makeApp((_req, _res, next) =>
      next(
        new PrismaClientValidationError("Invalid args", {
          clientVersion: "test",
        }),
      ),
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.message).toBe("Invalid database query parameters");
  });

  it("recognizes runtime-library Prisma errors via instanceof", () => {
    const known = prismaKnownError("P2025");
    const validation = new PrismaClientValidationError("bad", {
      clientVersion: "test",
    });
    expect(known).toBeInstanceOf(PrismaClientKnownRequestError);
    expect(validation).toBeInstanceOf(PrismaClientValidationError);
  });
});

describe("errorHandler backpressure mapping (#500)", () => {
  it("maps CircuitBreakerOpenError to 503 with Retry-After", async () => {
    const nextAttemptAt = new Date(Date.now() + 15_000);
    const app = makeApp((_req, _res, next) =>
      next(new CircuitBreakerOpenError("soroban-rpc", nextAttemptAt)),
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });

  it("maps BackpressureError to 503 with Retry-After", async () => {
    const app = makeApp((_req, _res, next) =>
      next(new BackpressureError("too many in flight", 2)),
    );

    const res = await request(app).get("/test");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body.retryAfter).toBe(2);
  });
});

describe("errorHandler via createApp routes (dual entrypoints)", () => {
  let fullApp: express.Express;
  let hackathonApp: express.Express;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require("../app-factory");
    fullApp = createApp({ mode: "full" });
    hackathonApp = createApp({ mode: "hackathon" });
  });

  it("404 handler returns structured NotFoundError shape with identical keys across entrypoints", async () => {
    const fullRes = await request(fullApp).get("/api/nonexistent-route-xyz");
    const hackathonRes = await request(hackathonApp).get("/api/nonexistent-route-xyz");

    expect(fullRes.status).toBe(404);
    expect(hackathonRes.status).toBe(404);

    const requiredKeys = ["code", "path", "requestId", "message", "error", "timestamp"];
    for (const key of requiredKeys) {
      expect(fullRes.body).toHaveProperty(key);
      expect(hackathonRes.body).toHaveProperty(key);
    }

    expect(fullRes.body.code).toBe("NOT_FOUND");
    expect(hackathonRes.body.code).toBe("NOT_FOUND");
    expect(fullRes.body.requestId).toBeDefined();
    expect(hackathonRes.body.requestId).toBeDefined();
  });

  it("400 validation error returns identical JSON keys and requestId on both entrypoints", async () => {
    const fullRes = await request(fullApp).post("/api/auth/challenge").send({});
    const hackathonRes = await request(hackathonApp).post("/api/auth/challenge").send({});

    expect(fullRes.status).toBe(400);
    expect(hackathonRes.status).toBe(400);

    const fullKeys = Object.keys(fullRes.body).sort();
    const hackathonKeys = Object.keys(hackathonRes.body).sort();

    expect(fullKeys).toEqual(hackathonKeys);
    expect(fullRes.body.requestId).toBeDefined();
    expect(hackathonRes.body.requestId).toBeDefined();
    expect(fullRes.body.code).toBe("VALIDATION_ERROR");
    expect(hackathonRes.body.code).toBe("VALIDATION_ERROR");
  });

  it("500 internal error returns identical JSON keys and requestId on both entrypoints", async () => {
    const errorAppFull = express();
    errorAppFull.use((req, _res, next) => { (req as any).requestId = "req-full-500"; next(); });
    errorAppFull.get("/err", () => { throw new Error("crash"); });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    errorAppFull.use(require("../middleware/errorHandler").errorHandler);

    const errorAppHackathon = express();
    errorAppHackathon.use((req, _res, next) => { (req as any).requestId = "req-hack-500"; next(); });
    errorAppHackathon.get("/err", () => { throw new Error("crash"); });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    errorAppHackathon.use(require("../middleware/errorHandler.middleware").errorHandler);

    const fullRes = await request(errorAppFull).get("/err");
    const hackathonRes = await request(errorAppHackathon).get("/err");

    expect(fullRes.status).toBe(500);
    expect(hackathonRes.status).toBe(500);

    expect(fullRes.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(hackathonRes.body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(fullRes.body.requestId).toBe("req-full-500");
    expect(hackathonRes.body.requestId).toBe("req-hack-500");
    expect(Object.keys(fullRes.body).sort()).toEqual(Object.keys(hackathonRes.body).sort());
  });
});
