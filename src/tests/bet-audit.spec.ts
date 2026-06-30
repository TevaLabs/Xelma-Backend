import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { betAuditService } from "../services/bet-audit.service";
import betService from "../services/bet.service";

// ----------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: "audit-123" }),
    },
  },
}));

import sorobanService from "../services/soroban.service";
import logger from "../utils/logger";
import { prisma } from "../lib/prisma";

const mockAuditLogCreate = prisma.auditLog.create as any;

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

// ================================================================
// BetAuditService unit tests
// ================================================================

describe("BetAuditService", () => {
  beforeEach(() => {
    betAuditService.clear();
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------
  // Test 3: Event schema contains required fields
  // --------------------------------------------------------------
  describe("event schema (test 3)", () => {
    it("should contain all required fields for UP_DOWN bet", () => {
      const event = betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      expect(event.event).toBe("BET_ACCEPTED");
      expect(event.roundId).toBeUndefined();
      expect(event.address).toBe(VALID_ADDRESS);
      expect(event.amount).toBe(100);
      expect(event.side).toBe("UP");
      expect(event.mode).toBe("UP_DOWN");
      expect(event.result).toBe("stub");
      expect(event.createdAt).toBeDefined();
      expect(typeof event.createdAt).toBe("string");
      expect(Date.parse(event.createdAt)).not.toBeNaN();
    });

    it("should create event for PRECISION mode without side", () => {
      const event = betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 50,
        mode: "PRECISION",
        result: "on-chain-success",
        txHash: "0xabc123",
      });

      expect(event.event).toBe("BET_ACCEPTED");
      expect(event.mode).toBe("PRECISION");
      expect(event.side).toBeUndefined();
      expect(event.txHash).toBe("0xabc123");
      expect(event.amount).toBe(50);
    });

    it("should generate a valid ISO-8601 timestamp", () => {
      const before = Date.now();
      const event = betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "DOWN",
        mode: "UP_DOWN",
        result: "stub",
      });
      const after = Date.now();

      const ts = Date.parse(event.createdAt);
      expect(ts).not.toBeNaN();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("should not contain sensitive data (secrets, tokens, keys)", () => {
      const event = betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      const json = JSON.stringify(event);
      expect(json).not.toContain("secret");
      expect(json).not.toContain("private_key");
      expect(json).not.toContain("privateKey");
      expect(json).not.toContain("token");
      expect(json).not.toContain("password");
      expect(json).not.toContain("jwt");
    });
  });

  // --------------------------------------------------------------
  // Test 4a: Storage behavior – memory mode
  // --------------------------------------------------------------
  describe("storage - memory mode (test 4a)", () => {
    it("should store event in memory and retrieve via getEvents", () => {
      expect(betAuditService.getEvents()).toHaveLength(0);

      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].address).toBe(VALID_ADDRESS);
    });

    it("should accumulate multiple events", () => {
      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 200,
        side: "DOWN",
        mode: "UP_DOWN",
        result: "on-chain-success",
        txHash: "0x456",
      });

      expect(betAuditService.getEvents()).toHaveLength(2);
    });

    it("should clear events when clear() is called", () => {
      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      expect(betAuditService.getEvents()).toHaveLength(1);

      betAuditService.clear();
      expect(betAuditService.getEvents()).toHaveLength(0);
    });

    it("should return a defensive copy from getEvents", () => {
      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      const events = betAuditService.getEvents();
      (events as any).push("tamper");
      expect(betAuditService.getEvents()).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------
  // Test 4b: Storage behavior – database mode (when implemented)
  // --------------------------------------------------------------
  describe("storage - database mode (test 4b)", () => {
    let originalStorage: string | undefined;

    beforeEach(() => {
      originalStorage = process.env.BET_AUDIT_STORAGE;
      process.env.BET_AUDIT_STORAGE = "database";
    });

    afterEach(() => {
      if (originalStorage !== undefined) {
        process.env.BET_AUDIT_STORAGE = originalStorage;
      } else {
        delete process.env.BET_AUDIT_STORAGE;
      }
    });

    it("should persist UP_DOWN bet to AuditLog table", async () => {
      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      // Wait for the async enrichAndPersist to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "BET_ACCEPTED",
            severity: "info",
            message: "Bet accepted: UP_DOWN UP",
            outcome: "success",
            actorType: "user",
            walletAddress: VALID_ADDRESS,
            resourceType: "bet",
            metadata: expect.objectContaining({
              amount: 100,
              side: "UP",
              mode: "UP_DOWN",
              result: "stub",
            }),
          }),
        }),
      );
    });

    it("should persist PRECISION bet to AuditLog table", async () => {
      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 50,
        mode: "PRECISION",
        result: "on-chain-success",
        txHash: "0xabc123",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "BET_ACCEPTED",
            message: "Bet accepted: PRECISION",
            metadata: expect.objectContaining({
              amount: 50,
              mode: "PRECISION",
              result: "on-chain-success",
              txHash: "0xabc123",
            }),
          }),
        }),
      );
    });

    it("should handle database errors gracefully", async () => {
      mockAuditLogCreate.mockRejectedValue(
        new Error("Database connection failed"),
      );

      betAuditService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(logger.error).toHaveBeenCalledWith(
        "Failed to persist bet audit event to database",
        expect.objectContaining({
          error: "Database connection failed",
        }),
      );
    });
  });

  // --------------------------------------------------------------
  // Storage mode selection
  // --------------------------------------------------------------
  describe("storage mode selection", () => {
    afterEach(() => {
      delete process.env.BET_AUDIT_STORAGE;
    });

    it('should default to "memory" when env var is not set', () => {
      delete process.env.BET_AUDIT_STORAGE;
      expect(betAuditService.storageMode).toBe("memory");
    });

    it('should return "database" when env var is set to "database"', () => {
      process.env.BET_AUDIT_STORAGE = "database";
      expect(betAuditService.storageMode).toBe("database");
    });

    it('should return "memory" for unknown env var values', () => {
      process.env.BET_AUDIT_STORAGE = "unknown";
      expect(betAuditService.storageMode).toBe("memory");
    });
  });
});

// ================================================================
// BetService + BetAuditService integration tests
// ================================================================

describe("BetService + AuditService integration", () => {
  beforeEach(() => {
    betAuditService.clear();
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------
  // Test 1: Accepted bet creates audit event
  // --------------------------------------------------------------
  describe("accepted bet creates audit event (test 1)", () => {
    it("should emit audit event for UP/DOWN bet in stub mode", async () => {
      process.env.BET_STUB_MODE = "true";

      await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "stub",
      });
    });

    it("should emit audit event for UP/DOWN bet in on-chain mode", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xtest123",
      });

      await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        address: VALID_ADDRESS,
        amount: 100,
        side: "UP",
        mode: "UP_DOWN",
        result: "on-chain-success",
        txHash: "0xtest123",
      });
    });

    it("should emit audit event for PRECISION bet", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xprecision",
      });

      await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 50,
        predictedPrice: 0.12,
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        address: VALID_ADDRESS,
        amount: 50,
        mode: "PRECISION",
        result: "on-chain-success",
        txHash: "0xprecision",
      });
    });

    it("should emit audit event for PRECISION bet in stub mode", async () => {
      process.env.BET_STUB_MODE = "true";

      await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 50,
        predictedPrice: 0.12,
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        address: VALID_ADDRESS,
        amount: 50,
        mode: "PRECISION",
        result: "stub",
      });
    });
  });

  // --------------------------------------------------------------
  // Test 2: Failed bet does NOT create audit event
  // --------------------------------------------------------------
  describe("failed bet does not create audit event (test 2)", () => {
    it("should not emit audit event when Soroban throws for UP/DOWN bet", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockRejectedValue(
        new Error("Soroban contract error: tx failed"),
      );

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 100,
          side: "UP",
        }),
      ).rejects.toThrow();

      expect(betAuditService.getEvents()).toHaveLength(0);
    });

    it("should not emit audit event when Soroban throws for PRECISION bet", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockRejectedValue(
        new Error("Circuit breaker is open"),
      );

      await expect(
        betService.recordPrecisionBet({
          address: VALID_ADDRESS,
          amount: 50,
          predictedPrice: 0.12,
        }),
      ).rejects.toThrow();

      expect(betAuditService.getEvents()).toHaveLength(0);
    });
  });
});
