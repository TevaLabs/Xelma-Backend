import { describe, it, expect, beforeAll, afterEach, beforeEach } from "@jest/globals";
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

  afterEach(async () => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    await prisma.idempotencyKey.deleteMany({});
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
      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBeUndefined();
      expect(res.body.message).toBeDefined();
    });

    // --- Idempotency Tests ---
    it("idempotency: first request creates a bet, duplicate request with same key does not create another bet and returns original response", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0xidempotent" });

      const key = "key-updown-123";
      const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };

      // First request
      const res1 = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res1.body.txHash).toBe("0xidempotent");
      expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);

      // Second request
      const res2 = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
      expect(sorobanService.placeBet).toHaveBeenCalledTimes(1); // Place bet still called only once
    });

    it("idempotency: expired key allows a new bet", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0xexpired" });

      const key = "key-updown-expired";
      const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };

      // First request
      const res1 = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);

      // Manually expire the key in DB
      await prisma.idempotencyKey.updateMany({
        where: { idempotencyKey: key },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Second request
      const res2 = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(sorobanService.placeBet).toHaveBeenCalledTimes(2); // Called again because first was expired
    });

    it("idempotency: missing header behaves exactly as before", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0xnoheader" });

      const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };

      await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send(payload);

      await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .send(payload);

      expect(sorobanService.placeBet).toHaveBeenCalledTimes(2);
    });

    it("idempotency: concurrent retries only trigger bet creation once", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        return { state: "on-chain-success", txHash: "0xconcurrent" };
      });

      const key = "key-updown-concurrent";
      const payload = { address: VALID_ADDRESS, amount: 10, side: "UP" };

      const requests = Array.from({ length: 5 }).map(() =>
        request(app)
          .post("/api/bets/up-down")
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key)
          .send(payload)
      );

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.txHash).toBe("0xconcurrent");
      }

      expect(sorobanService.placeBet).toHaveBeenCalledTimes(1);
    });

    it("idempotency: returns 409 Conflict if key is reused with a different body", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0xconflict" });

      const key = "key-updown-conflict";

      await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      const res = await request(app)
        .post("/api/bets/up-down")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ address: VALID_ADDRESS, amount: 20, side: "UP" }); // Changed amount

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONFLICT");
      expect(res.body.message).toContain("different request body");
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
      const res = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
    });

    // --- Idempotency Tests ---
    it("idempotency: precision first request creates a bet, duplicate request with same key returns original response", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({ state: "on-chain-success", txHash: "0xprecision-idemp" });

      const key = "key-precision-123";
      const payload = { address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 };

      const res1 = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(sorobanService.placePrecisionBet).toHaveBeenCalledTimes(1);

      const res2 = await request(app)
        .post("/api/bets/precision")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body).toEqual(res1.body);
      expect(sorobanService.placePrecisionBet).toHaveBeenCalledTimes(1);
    });
  });
});
