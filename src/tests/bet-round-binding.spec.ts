/**
 * Round binding for BetService.
 *
 * Round-scoped endpoints (`POST /api/rounds/:id/bet` and the hackathon bet
 * variants) pass the path round id straight through to BetService. These tests
 * cover both halves of that contract: an explicit round id must be honoured
 * and validated, and omitting it must keep the previous "newest ACTIVE round
 * for the mode" behaviour that `/api/bets/*` relies on.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

const mockRoundFindUnique = jest.fn();
const mockRoundFindFirst = jest.fn();
const mockBetCreate = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    $transaction: jest.fn((fn: any) => {
      let lastCreatedBet: any = null;
      return fn({
        user: {
          findUnique: jest.fn<any>().mockResolvedValue({ id: "u1" }),
          create: jest.fn<any>().mockResolvedValue({ id: "u1" }),
        },
        round: {
          findUnique: (...args: unknown[]) => mockRoundFindUnique(...args),
          findFirst: (...args: unknown[]) => mockRoundFindFirst(...args),
        },
        bet: {
          create: (args: any) => {
            mockBetCreate(args);
            lastCreatedBet = {
              id: "bet-1",
              ...args.data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            return Promise.resolve(lastCreatedBet);
          },
          findUnique: jest.fn(() => Promise.resolve(lastCreatedBet)),
          update: jest.fn((args: any) => Promise.resolve(args.data)),
        },
        outboxEvent: { create: jest.fn<any>().mockResolvedValue({ id: "outbox-1" }) },
      });
    }),
  },
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
  },
}));

jest.mock("../services/outbox.service", () => ({
  __esModule: true,
  default: { processOutbox: jest.fn(), cleanupProcessed: jest.fn() },
}));

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitBetFailed: jest.fn(),
    emitBetReconciled: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import betService from "../services/bet.service";
import sorobanService from "../services/soroban.service";
import { NotFoundError, ValidationError } from "../utils/errors";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

describe("BetService round binding", () => {
  const originalStubMode = process.env.BET_STUB_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BET_STUB_MODE = "true";
    mockRoundFindFirst.mockResolvedValue({ id: "active-round" });
  });

  afterEach(() => {
    if (originalStubMode === undefined) {
      delete process.env.BET_STUB_MODE;
    } else {
      process.env.BET_STUB_MODE = originalStubMode;
    }
  });

  describe("explicit roundId", () => {
    it("binds an UP/DOWN bet to the requested round", async () => {
      mockRoundFindUnique.mockResolvedValue({ id: "round-7", mode: "UP_DOWN" });

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: "round-7",
      });

      expect(result.state).toBe("stub");
      expect(mockRoundFindUnique).toHaveBeenCalledWith({
        where: { id: "round-7" },
        select: { id: true, mode: true },
      });
      expect(mockBetCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roundId: "round-7" }),
        }),
      );
      // The named round wins; the active-round fallback is never consulted.
      expect(mockRoundFindFirst).not.toHaveBeenCalled();
    });

    it("binds a Precision bet to the requested LEGENDS round", async () => {
      mockRoundFindUnique.mockResolvedValue({ id: "round-9", mode: "LEGENDS" });

      await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 5,
        predictedPrice: 0.12,
        roundId: "round-9",
      });

      expect(mockBetCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roundId: "round-9" }),
        }),
      );
    });

    it("rejects an unknown round with NotFoundError instead of silently falling back", async () => {
      mockRoundFindUnique.mockResolvedValue(null);

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: "missing-round",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(mockBetCreate).not.toHaveBeenCalled();
    });

    it("rejects an UP/DOWN bet aimed at a LEGENDS round", async () => {
      mockRoundFindUnique.mockResolvedValue({ id: "round-9", mode: "LEGENDS" });

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: "round-9",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(mockBetCreate).not.toHaveBeenCalled();
    });

    it("rejects a Precision bet aimed at an UP_DOWN round", async () => {
      mockRoundFindUnique.mockResolvedValue({ id: "round-7", mode: "UP_DOWN" });

      await expect(
        betService.recordPrecisionBet({
          address: VALID_ADDRESS,
          amount: 5,
          predictedPrice: 0.12,
          roundId: "round-7",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(mockBetCreate).not.toHaveBeenCalled();
    });
  });

  describe("omitted roundId", () => {
    it("falls back to the newest ACTIVE round for the mode", async () => {
      await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
      });

      expect(mockRoundFindUnique).not.toHaveBeenCalled();
      expect(mockRoundFindFirst).toHaveBeenCalledWith({
        where: { mode: "UP_DOWN", status: "ACTIVE" },
        orderBy: { startTime: "desc" },
        select: { id: true },
      });
      expect(mockBetCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roundId: "active-round" }),
        }),
      );
    });

    it("records the bet with a null round when nothing is active", async () => {
      mockRoundFindFirst.mockResolvedValue(null);

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
      });

      expect(result.state).toBe("stub");
      expect(mockBetCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roundId: null }),
        }),
      );
    });
  });

  describe("on-chain mode", () => {
    it("submits a round-bound bet to Soroban and returns the tx hash", async () => {
      process.env.BET_STUB_MODE = "false";
      mockRoundFindUnique.mockResolvedValue({ id: "round-7", mode: "UP_DOWN" });
      (sorobanService.placeBet as jest.Mock<any>).mockResolvedValue({
        state: "submitted",
        txHash: "deadbeef",
      });

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: "round-7",
      });

      expect(sorobanService.placeBet).toHaveBeenCalledWith(VALID_ADDRESS, 10, "UP");
      expect(result.txHash).toBe("deadbeef");
      expect(result.status).toBe("SUBMITTED");
    });

    it("propagates a Soroban failure so the route can surface a structured error", async () => {
      process.env.BET_STUB_MODE = "false";
      mockRoundFindUnique.mockResolvedValue({ id: "round-7", mode: "UP_DOWN" });
      (sorobanService.placeBet as jest.Mock<any>).mockRejectedValue(
        new Error("tx simulation failed"),
      );

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: "round-7",
        }),
      ).rejects.toThrow("tx simulation failed");
    });

    it("never contacts Soroban while stub mode is on", async () => {
      mockRoundFindUnique.mockResolvedValue({ id: "round-7", mode: "UP_DOWN" });

      await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: "round-7",
      });

      expect(sorobanService.placeBet).not.toHaveBeenCalled();
    });
  });
});
