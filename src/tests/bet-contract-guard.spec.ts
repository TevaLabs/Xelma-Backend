/**
 * Contract id guard for BetService (#995): on-chain bets are rejected with a
 * clear error when no Soroban contract id is configured; stub mode is unaffected.
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
import config from "../config";
import sorobanService from "../services/soroban.service";
import { NotFoundError, ValidationError } from "../utils/errors";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

describe("BetService contract id guard", () => {
  const originalStubMode = process.env.BET_STUB_MODE;
  const originalContractId = config.soroban.contractId;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRoundFindFirst.mockResolvedValue({ id: "active-round" });
  });

  afterEach(() => {
    config.soroban.contractId = originalContractId;
    if (originalStubMode === undefined) delete process.env.BET_STUB_MODE;
    else process.env.BET_STUB_MODE = originalStubMode;
  });

  it("rejects an on-chain UP/DOWN bet when the contract id is missing", async () => {
    process.env.BET_STUB_MODE = "false";
    config.soroban.contractId = "";

    await expect(
      betService.recordUpDownBet({ address: VALID_ADDRESS, amount: 10, side: "UP" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "SOROBAN_CONTRACT_NOT_CONFIGURED" });
    expect(mockBetCreate).not.toHaveBeenCalled();
    expect(sorobanService.placeBet).not.toHaveBeenCalled();
  });

  it("rejects an on-chain Precision bet when the contract id is missing", async () => {
    process.env.BET_STUB_MODE = "false";
    config.soroban.contractId = "";

    await expect(
      betService.recordPrecisionBet({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 }),
    ).rejects.toMatchObject({ code: "SOROBAN_CONTRACT_NOT_CONFIGURED" });
    expect(mockBetCreate).not.toHaveBeenCalled();
    expect(sorobanService.placePrecisionBet).not.toHaveBeenCalled();
  });

  it("still records stub bets without a contract id", async () => {
    process.env.BET_STUB_MODE = "true";
    config.soroban.contractId = "";

    const result = await betService.recordUpDownBet({ address: VALID_ADDRESS, amount: 10, side: "UP" });
    expect(result.state).toBe("stub");
    expect(mockBetCreate).toHaveBeenCalled();
  });

  it("allows on-chain bets when a contract id is configured", async () => {
    process.env.BET_STUB_MODE = "false";
    config.soroban.contractId = "CABC";
    (sorobanService.placeBet as jest.Mock<any>).mockResolvedValue({ state: "on-chain-success", txHash: "0x1" });

    const result = await betService.recordUpDownBet({ address: VALID_ADDRESS, amount: 10, side: "UP" });
    expect(result.state).toBe("on-chain-success");
  });
});
