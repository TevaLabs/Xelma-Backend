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
    updateMany: jest.fn(),
  };
  return {
    prisma: {
      claim,
      mockLeaderboard,
      user: { findUnique: jest.fn(), create: jest.fn() },
      bet: { findMany: jest.fn() },
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn({ claim, mockLeaderboard })),
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
const mockLeaderboard = (prisma as any).mockLeaderboard;

describe("BetService.claimWinnings", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BET_STUB_MODE = "false";
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimCreate.mockResolvedValue({ id: "claim-1" });
    mockClaimUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("credits pending demo winnings, clears pending, and records a confirmed claim", async () => {
    process.env.BET_STUB_MODE = "true";
    const user = { address: VALID_ADDRESS, balance: 100, pendingWinnings: 12.5 };
    mockLeaderboard.findUnique.mockImplementation(async () => ({ ...user }));
    mockLeaderboard.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.pendingWinnings !== user.pendingWinnings) return { count: 0 };
      user.balance += data.balance.increment;
      user.pendingWinnings = data.pendingWinnings.set;
      return { count: 1 };
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result).toEqual({ state: "stub", amount: 12.5, balance: 112.5, pendingWinnings: 0 });
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
    expect(prisma.claim.findFirst).not.toHaveBeenCalled();
    expect(mockLeaderboard.updateMany).toHaveBeenCalledWith({
      where: { address: VALID_ADDRESS, pendingWinnings: 12.5 },
      data: { balance: { increment: 12.5 }, pendingWinnings: { set: 0 } },
    });
    expect(mockClaimCreate).toHaveBeenCalledTimes(1);
    const claimData = mockClaimCreate.mock.calls[0][0].data;
    expect(claimData.walletAddress).toBe(VALID_ADDRESS);
    expect(claimData.amount.toNumber()).toBe(12.5);
    expect(claimData.status).toBe(ClaimStatus.CONFIRMED);
    expect(claimData.claimedAt).toEqual(expect.any(Date));
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(expect.objectContaining({
      address: VALID_ADDRESS,
      amount: 12.5,
      result: "stub",
      txHash: undefined,
    }));
  });

  it("does not credit or ledger the same pending amount twice", async () => {
    process.env.BET_STUB_MODE = "true";
    const user = { address: VALID_ADDRESS, balance: 100, pendingWinnings: 8 };
    mockLeaderboard.findUnique.mockImplementation(async () => ({ ...user }));
    mockLeaderboard.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.pendingWinnings !== user.pendingWinnings) return { count: 0 };
      user.balance += data.balance.increment;
      user.pendingWinnings = data.pendingWinnings.set;
      return { count: 1 };
    });

    const first = await betService.claimWinnings(VALID_ADDRESS, "same-key-123");
    const duplicate = await betService.claimWinnings(VALID_ADDRESS, "same-key-123");

    expect(first.amount).toBe(8);
    expect(duplicate.amount).toBe(0);
    expect(user).toEqual({ address: VALID_ADDRESS, balance: 108, pendingWinnings: 0 });
    expect(mockClaimCreate).toHaveBeenCalledTimes(1);
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
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
