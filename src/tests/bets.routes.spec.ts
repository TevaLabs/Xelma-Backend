import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("Bets Routes - stub endpoints", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  describe("POST /api/bets/up-down", () => {
    it("returns 200 stub for valid UP/DOWN payload", async () => {
      const res = await request(app)
        .post("/api/bets/up-down")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Bet recorded (stub)",
      });
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/bets/up-down")
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBeUndefined();
      expect(res.body.message).toBeDefined();
    });
  });

  describe("POST /api/bets/precision", () => {
    it("returns 200 stub for valid Precision payload", async () => {
      const res = await request(app)
        .post("/api/bets/precision")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Bet recorded (stub)",
      });
    });

    it("returns 400 when predictedPrice is missing", async () => {
      const res = await request(app)
        .post("/api/bets/precision")
        .send({ address: VALID_ADDRESS, amount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
    });
  });
});
