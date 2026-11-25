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
  return {
    prisma: {
      claim,
      user: { findUnique: jest.fn(), create: jest.fn() },
      bet: { findMany: jest.fn() },
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn({ claim })),
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

  it("returns stub claim when BET_STUB_MODE=true and touches no claim ledger", async () => {
    process.env.BET_STUB_MODE = "true";

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result).toEqual({ state: "stub", amount: 0 });
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
    expect(prisma.claim.findFirst).not.toHaveBeenCalled();
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith({
      address: VALID_ADDRESS,
      amount: 0,
      result: "stub",
      txHash: undefined,
    });
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

  it("is idempotent: a duplicate claim returns the same result and pays out only once", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 5,
      txHash: "0xfirst",
    });

    // First call: no open claim, submits on-chain and records a SUBMITTED row.
    const first = await betService.claimWinnings(VALID_ADDRESS);
    expect(first).toEqual({ state: "on-chain-success", amount: 5, txHash: "0xfirst" });
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(1);
    expect(mockClaimCreate).toHaveBeenCalledTimes(1);

    // Duplicate call: ledger now shows the SUBMITTED row.
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-1",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.SUBMITTED,
      txHash: "0xfirst",
      amount: 5,
    });
    const second = await betService.claimWinnings(VALID_ADDRESS);
    const third = await betService.claimWinnings(VALID_ADDRESS);

    expect(second).toEqual({ state: "already-submitted", amount: 5, txHash: "0xfirst" });
    expect(third).toEqual(second);
    // No second on-chain payout, no second ledger row.
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(1);
    expect(mockClaimCreate).toHaveBeenCalledTimes(1);
    expect(mockClaimUpdateMany).not.toHaveBeenCalled();
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
