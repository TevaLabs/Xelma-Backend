import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../app";

jest.mock("../middleware/rateLimiter", () => {
  const mockMiddleware = (req: any, res: any, next: any) => next();
  return {
    apiRateLimiter: mockMiddleware,
    writeRateLimiter: mockMiddleware,
    betRateLimiter: mockMiddleware,
  };
});

jest.mock("../services/hackathon.service", () => {
  return {
    __esModule: true,
    default: {
      placeBet: jest.fn().mockResolvedValue(undefined),
      getRounds: jest.fn().mockResolvedValue([]),
      getLeaderboard: jest.fn().mockResolvedValue([]),
      getUserStats: jest.fn().mockResolvedValue({}),
    },
  };
});

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("Hackathon Bet Routes - Zod validation", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  describe("POST /api/rounds/hackathon/up-down/:id/bet", () => {
    it("should return 200 for valid UP/DOWN bet payload", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Bet recorded (stub)",
      });
    });

    it("should return 400 for missing required fields", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.message).toBeDefined();
      expect(res.body.details).toBeDefined();
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it("should return 400 for invalid side value", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 10, side: "INVALID" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.message).toBeDefined();
    });

    it("should return 400 for negative amount", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: -5, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for zero amount", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 0, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for invalid address format", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: "INVALID_ADDRESS", amount: 10, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/rounds/hackathon/precision/:id/bet", () => {
    it("should return 200 for valid Precision bet payload", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Precision bet recorded (stub)",
      });
    });

    it("should return 400 for missing predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for zero predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for negative predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: -1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for non-numeric predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });
  });
});