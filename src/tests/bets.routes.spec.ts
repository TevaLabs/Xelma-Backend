import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../index";
import sorobanService from "../services/soroban.service";
import { UserRole } from "@prisma/client";
import { generateToken } from "../utils/jwt.util";

jest.mock("../services/soroban.service", () => {
  return {
    __esModule: true,
    default: {
      placeBet: jest.fn(),
      placePrecisionBet: jest.fn(),
    },
  };
});

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZ";

describe("Bets Routes", () => {
  let app: Express;
  let token: string;
  const originalEnv = process.env;

  beforeAll(() => {
    app = createApp();
    token = generateToken("user-1", VALID_ADDRESS, UserRole.USER);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  describe("POST /api/bets/up-down", () => {
    it("returns 200 stub for valid UP/DOWN payload when BET_STUB_MODE is true", async () => {
      process.env.BET_STUB_MODE = "true";
      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Bet recorded (stub)",
        state: "stub",
      });
    });

    it("returns 200 and calls SorobanService when BET_STUB_MODE is false", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0x123" });

      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(sorobanService.placeBet).toHaveBeenCalledWith(VALID_ADDRESS, 10, "UP");
      expect(res.body).toEqual({
        success: true,
        message: "Bet placed on-chain",
        state: "on-chain-success",
        txHash: "0x123",
      });
    });

    it("returns 503 if Soroban contract interaction fails", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockRejectedValue(new Error("Soroban contract error: tx failed"));

      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        error: "Contract interaction failed. Please try again.",
      });
    });

    it("rejects mismatched wallet address with 403", async () => {
      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${validToken}`)
        .send({
          address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          amount: 10,
          side: "UP",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
    });

    it("returns 400 when required fields are missing", async () => {
      const token = generateToken("user-1", VALID_ADDRESS, UserRole.USER);
      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBeUndefined();
      expect(res.body.message).toBeDefined();
    });
  });

  describe("POST /api/bets/precision", () => {
    it("returns 200 stub for valid Precision payload when BET_STUB_MODE is true", async () => {
      process.env.BET_STUB_MODE = "true";
      const res = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: "Bet recorded (stub)",
        state: "stub",
      });
    });

    it("returns 200 and calls SorobanService when BET_STUB_MODE is false", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0x456" });

      const res = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(sorobanService.placePrecisionBet).toHaveBeenCalledWith(VALID_ADDRESS, 5, 0.12);
      expect(res.body).toEqual({
        success: true,
        message: "Bet placed on-chain",
        state: "on-chain-success",
        txHash: "0x456",
      });
    });

    it("returns 503 if Soroban contract interaction fails", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockRejectedValue(new Error("Circuit breaker is open"));

      const res = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        error: "Contract interaction failed. Please try again.",
      });
    });

    it("returns 400 when predictedPrice is missing", async () => {
      const token = generateToken("user-1", VALID_ADDRESS, UserRole.USER);
      const res = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
    });
  });
});
