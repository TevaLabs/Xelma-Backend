/**
 * Regression coverage for Issue #840 — reject bet placement when a round is
 * flagged `isSoroban` but no Soroban contract is configured.
 *
 * A round created while the contract was available keeps `isSoroban: true`.
 * If the service later starts without `SOROBAN_CONTRACT_ID` (or the client
 * fails to initialize), accepting a bet would record money locally that can
 * never reach the contract. The guard must fail closed with a clear,
 * machine-readable error instead.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { ErrorCode } from "../utils/errors";

const mockRoundFindFirst: any = jest.fn();
const mockRoundFindUnique: any = jest.fn();
const mockBetCreate: any = jest.fn();
const mockBetUpdate: any = jest.fn();
const mockBetFindUnique: any = jest.fn();
const mockOutboxCreate: any = jest.fn();

jest.mock("../lib/prisma", () => {
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: "user-1" }),
      create: jest.fn(),
    },
    round: {
      findFirst: (...args: any[]) => mockRoundFindFirst(...args),
      findUnique: (...args: any[]) => mockRoundFindUnique(...args),
    },
    bet: {
      create: (...args: any[]) => mockBetCreate(...args),
      update: (...args: any[]) => mockBetUpdate(...args),
      findUnique: (...args: any[]) => mockBetFindUnique(...args),
    },
    outboxEvent: { create: (...args: any[]) => mockOutboxCreate(...args) },
  };

  return {
    prisma: {
      $transaction: jest.fn((fn: any) => fn(tx)),
      round: { findFirst: jest.fn(), findUnique: jest.fn() },
      user: { findUnique: jest.fn(), create: jest.fn() },
      bet: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
      outboxEvent: { create: jest.fn() },
    },
  };
});

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    isReady: jest.fn(),
  },
}));

jest.mock("../services/outbox.service", () => ({
  __esModule: true,
  default: { processOutbox: jest.fn(), cleanupProcessed: jest.fn() },
  BetAcceptedOutboxPayload: {},
  BetConfirmedOutboxPayload: {},
  BetResolvedOutboxPayload: {},
  BetFailedOutboxPayload: {},
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
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import betService from "../services/bet.service";
import sorobanService from "../services/soroban.service";

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const SOROBAN_ROUND = {
  id: "round-soroban-1",
  mode: "UP_DOWN",
  isSoroban: true,
};

const PRECISION_ROUND = {
  id: "round-precision-1",
  mode: "LEGENDS",
  isSoroban: true,
};

const STORED_BET = {
  id: "bet-1",
  userId: "user-1",
  roundId: SOROBAN_ROUND.id,
  mode: "UP_DOWN",
  side: "UP",
  amount: 10,
  predictedPrice: null,
  status: "ACCEPTED",
  txHash: null,
  failureReason: null,
  submittedAt: null,
  confirmedAt: null,
  resolvedAt: null,
  failedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("BetService contract guard (#840)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, BET_STUB_MODE: "false" };
    mockBetCreate.mockResolvedValue(STORED_BET);
    mockBetUpdate.mockResolvedValue(STORED_BET);
    mockBetFindUnique.mockResolvedValue(STORED_BET);
    mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
    (sorobanService.placeBet as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      txHash: "0xabc",
    });
    (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      txHash: "0xdef",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("round flagged isSoroban without a configured contract", () => {
    beforeEach(() => {
      (sorobanService.isReady as jest.Mock).mockReturnValue(false);
    });

    it("rejects an UP/DOWN bet bound to that round with a clear contract error", async () => {
      mockRoundFindUnique.mockResolvedValue(SOROBAN_ROUND);

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: SOROBAN_ROUND.id,
        }),
      ).rejects.toMatchObject({
        name: "BusinessRuleError",
        code: ErrorCode.CONTRACT_INVALID_STATE,
        statusCode: 422,
        message: expect.stringContaining("SOROBAN_CONTRACT_ID"),
      });

      // The bet must never be recorded when the contract could not accept it.
      expect(mockBetCreate).not.toHaveBeenCalled();
      expect(sorobanService.placeBet).not.toHaveBeenCalled();
    });

    it("rejects a Precision bet bound to that round with a clear contract error", async () => {
      mockRoundFindUnique.mockResolvedValue(PRECISION_ROUND);

      await expect(
        betService.recordPrecisionBet({
          address: VALID_ADDRESS,
          amount: 5,
          predictedPrice: 0.12,
          roundId: PRECISION_ROUND.id,
        }),
      ).rejects.toMatchObject({
        name: "BusinessRuleError",
        code: ErrorCode.CONTRACT_INVALID_STATE,
        statusCode: 422,
        message: expect.stringContaining("no Soroban contract is configured"),
      });

      expect(mockBetCreate).not.toHaveBeenCalled();
      expect(sorobanService.placePrecisionBet).not.toHaveBeenCalled();
    });

    it("rejects a bet when the implicitly resolved active round is on-chain", async () => {
      mockRoundFindFirst.mockResolvedValue(SOROBAN_ROUND);

      await expect(
        betService.recordUpDownBet({ address: VALID_ADDRESS, amount: 10, side: "DOWN" }),
      ).rejects.toMatchObject({
        code: ErrorCode.CONTRACT_INVALID_STATE,
      });

      expect(mockBetCreate).not.toHaveBeenCalled();
    });

    it("names the offending round in the error message", async () => {
      mockRoundFindUnique.mockResolvedValue(SOROBAN_ROUND);

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: SOROBAN_ROUND.id,
        }),
      ).rejects.toThrow(SOROBAN_ROUND.id);
    });
  });

  describe("guard allows bets when the round/contract pair is consistent", () => {
    it("allows the bet when the round is on-chain and the contract is ready", async () => {
      (sorobanService.isReady as jest.Mock).mockReturnValue(true);
      mockRoundFindUnique.mockResolvedValue(SOROBAN_ROUND);

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: SOROBAN_ROUND.id,
      });

      expect(result.txHash).toBe("0xabc");
      expect(sorobanService.placeBet).toHaveBeenCalledWith(VALID_ADDRESS, 10, "UP");
      expect(mockBetCreate).toHaveBeenCalled();
    });

    it("allows a database-only round even when no contract is configured", async () => {
      (sorobanService.isReady as jest.Mock).mockReturnValue(false);
      mockRoundFindUnique.mockResolvedValue({ ...SOROBAN_ROUND, isSoroban: false });

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: SOROBAN_ROUND.id,
      });

      expect(result.txHash).toBe("0xabc");
      expect(mockBetCreate).toHaveBeenCalled();
    });

    it("allows stub-mode bets because they never touch the chain", async () => {
      process.env.BET_STUB_MODE = "true";
      (sorobanService.isReady as jest.Mock).mockReturnValue(false);
      mockRoundFindUnique.mockResolvedValue(SOROBAN_ROUND);

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
        roundId: SOROBAN_ROUND.id,
      });

      expect(result.state).toBe("stub");
      expect(sorobanService.placeBet).not.toHaveBeenCalled();
      expect(mockBetCreate).toHaveBeenCalled();
    });
  });
});
