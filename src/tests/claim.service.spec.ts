import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import betService from "../services/bet.service";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../lib/prisma", () => {
  const claim = {
    findFirst: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  };
  const mockLeaderboard = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const prediction = {
    findMany: jest.fn(),
  };
  const user = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const bet = {
    findMany: jest.fn(),
  };
  const txClient = { claim, mockLeaderboard, prediction, user, bet };
  return {
    prisma: {
      claim,
      mockLeaderboard,
      prediction,
      user,
      bet,
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(txClient)),
    },
  };
});

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitClaimAccepted: jest.fn(),
  },
}));

jest.mock("../services/websocket.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
  },
}));

import sorobanService from "../services/soroban.service";
import betAuditService from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";
import { ClaimStatus } from "@prisma/client";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

const mockClaimFindFirst = prisma.claim.findFirst as jest.Mock;
const mockClaimCreate = prisma.claim.create as jest.Mock;
const mockClaimUpdateMany = prisma.claim.updateMany as jest.Mock;
const mockMockLeaderboardFindUnique = prisma.mockLeaderboard.findUnique as jest.Mock;
const mockMockLeaderboardUpdate = prisma.mockLeaderboard.update as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockPredictionFindMany = prisma.prediction.findMany as jest.Mock;

describe("BetService.claimWinnings (stub mode)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BET_STUB_MODE = "true";
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimCreate.mockResolvedValue({ id: "claim-1" });
    mockClaimUpdateMany.mockResolvedValue({ count: 1 });
    mockMockLeaderboardFindUnique.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue(null);
    mockPredictionFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("Stub claim updates balance by the correct amount", async () => {
    mockMockLeaderboardFindUnique.mockResolvedValue({
      address: VALID_ADDRESS,
      balance: 1000,
      pendingWinnings: 50,
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result.state).toBe("stub");
    expect(result.amount).toBe(50);
    expect(result.txHash).toBeDefined();

    expect(mockMockLeaderboardUpdate).toHaveBeenCalledWith({
      where: { address: VALID_ADDRESS },
      data: {
        balance: { increment: 50 },
        pendingWinnings: 0,
      },
    });

    expect(mockClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.CONFIRMED,
        amount: expect.anything(),
      }),
    });
  });

  it("Pending winnings are cleared after claim", async () => {
    mockMockLeaderboardFindUnique.mockResolvedValue({
      address: VALID_ADDRESS,
      balance: 1000,
      pendingWinnings: 100,
    });

    await betService.claimWinnings(VALID_ADDRESS);

    expect(mockMockLeaderboardUpdate).toHaveBeenCalledWith({
      where: { address: VALID_ADDRESS },
      data: expect.objectContaining({
        pendingWinnings: 0,
      }),
    });
  });

  it("Double claim is rejected or returns idempotent result with no second balance change", async () => {
    // First claim has 50 pending winnings
    mockMockLeaderboardFindUnique
      .mockResolvedValueOnce({
        address: VALID_ADDRESS,
        balance: 1000,
        pendingWinnings: 50,
      })
      .mockResolvedValueOnce({
        address: VALID_ADDRESS,
        balance: 1050,
        pendingWinnings: 0,
      });

    // First call succeeds
    const firstResult = await betService.claimWinnings(VALID_ADDRESS);
    expect(firstResult.amount).toBe(50);

    // Second call with pendingWinnings=0 throws BusinessRuleError / 422
    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "No claimable winnings available."
    );

    // mockMockLeaderboardUpdate was only called once
    expect(mockMockLeaderboardUpdate).toHaveBeenCalledTimes(1);
  });

  it("Claim on a non-winning bet is rejected", async () => {
    mockMockLeaderboardFindUnique.mockResolvedValue({
      address: VALID_ADDRESS,
      balance: 1000,
      pendingWinnings: 0,
    });

    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "No claimable winnings available."
    );

    expect(mockMockLeaderboardUpdate).not.toHaveBeenCalled();
    expect(mockClaimCreate).not.toHaveBeenCalled();
  });
});

describe("BetService.claimWinnings (on-chain mode)", () => {
  beforeEach(() => {
    process.env.BET_STUB_MODE = "false";
    mockClaimFindFirst.mockResolvedValue(null);
  });

  it("calls SorobanService, records the claim ledger, and audits when BET_STUB_MODE=false", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 12.5,
      txHash: "0xclaim",
    });

    const result = await betService.claimWinnings(VALID_ADDRESS, "idem-key-1");

    expect(result).toEqual({
      state: "on-chain-success",
      amount: 12.5,
      txHash: "0xclaim",
    });
    expect(sorobanService.claimWinnings).toHaveBeenCalledWith(VALID_ADDRESS);
    // No open claim existed -> a fresh SUBMITTED row is created.
    expect(mockClaimFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletAddress: VALID_ADDRESS }),
      })
    );
    expect(mockClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.SUBMITTED,
        txHash: "0xclaim",
        amount: 12.5,
      }),
    });
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VALID_ADDRESS,
        amount: 12.5,
        result: "on-chain-success",
        txHash: "0xclaim",
      })
    );
  });

  it("does not double-submit when a SUBMITTED claim is already in flight", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-in-flight",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.SUBMITTED,
      txHash: "0xinflight",
      amount: 8,
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result).toEqual({
      state: "already-submitted",
      amount: 8,
      txHash: "0xinflight",
    });
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
    expect(mockClaimCreate).not.toHaveBeenCalled();
    expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VALID_ADDRESS,
        result: "already-submitted",
        txHash: "0xinflight",
      })
    );
  });

  it("updates an existing PENDING/FAILED claim row to SUBMITTED after a successful claim", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-retry",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.FAILED,
      txHash: null,
      amount: null,
    });
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 3.25,
      txHash: "0xretried",
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result.txHash).toBe("0xretried");
    expect(mockClaimCreate).not.toHaveBeenCalled();
    expect(mockClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "claim-retry",
        status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
      },
      data: expect.objectContaining({
        status: ClaimStatus.SUBMITTED,
        txHash: "0xretried",
        amount: 3.25,
      }),
    });
  });

  it("records a FAILED claim row and rethrows when Soroban claim throws", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockRejectedValue(
      new Error("contract failed")
    );

    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "contract failed"
    );
    expect(mockClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.FAILED,
        attempts: 1,
        lastError: "contract failed",
      }),
    });
    expect(betAuditService.emitClaimAccepted).not.toHaveBeenCalled();
  });

  it("increments attempts on an existing row when the claim fails", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-retry",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.FAILED,
      txHash: null,
      amount: null,
    });
    (sorobanService.claimWinnings as jest.Mock).mockRejectedValue(
      new Error("RPC timeout")
    );

    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "RPC timeout"
    );
    expect(mockClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "claim-retry",
        status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
      },
      data: expect.objectContaining({
        status: ClaimStatus.FAILED,
        attempts: { increment: 1 },
        lastError: "RPC timeout",
      }),
    });
    expect(mockClaimCreate).not.toHaveBeenCalled();
  });
});
