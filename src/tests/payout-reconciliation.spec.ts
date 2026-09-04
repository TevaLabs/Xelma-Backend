import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { ClaimStatus, BetStatus } from "@prisma/client";

jest.mock("../lib/prisma", () => {
  const claim = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    groupBy: jest.fn(),
  };
  const bet = {
    groupBy: jest.fn(),
    findMany: jest.fn(),
  };
  const user = {
    findUnique: jest.fn(),
  };
  return {
    prisma: {
      claim,
      bet,
      user,
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn({ claim, bet, user })),
    },
  };
});

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getPendingWinnings: jest.fn(),
    claimWinnings: jest.fn(),
    getTransactionStatus: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitClaimAccepted: jest.fn(),
  },
}));

import { prisma } from "../lib/prisma";
import sorobanService from "../services/soroban.service";
import betAuditService from "../services/bet-audit.service";
import payoutReconciliationService from "../services/payout-reconciliation.service";

const mockClaimFindMany = prisma.claim.findMany as jest.Mock;
const mockClaimFindFirst = prisma.claim.findFirst as jest.Mock;
const mockClaimCreate = prisma.claim.create as jest.Mock;
const mockClaimUpdateMany = prisma.claim.updateMany as jest.Mock;
const mockClaimGroupBy = prisma.claim.groupBy as jest.Mock;
const mockBetGroupBy = prisma.bet.groupBy as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockGetPendingWinnings = sorobanService.getPendingWinnings as jest.Mock;
const mockClaimWinnings = sorobanService.claimWinnings as jest.Mock;
const mockGetTransactionStatus = sorobanService.getTransactionStatus as jest.Mock;

const ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
const OTHER_ADDRESS = "GZZZZZZ1234567890ABCDEF1234567890ABCDEF1234567890";

/** Old enough (10 min) to clear the default 1-minute age cutoffs. */
const OLD = new Date(Date.now() - 10 * 60 * 1000);

function makeRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: "claim-1",
    userId: "user-1",
    walletAddress: ADDRESS,
    amount: null,
    status: ClaimStatus.PENDING,
    txHash: null,
    attempts: 0,
    lastError: null,
    claimedAt: null,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

const emptyResult = {
  checked: 0,
  submitted: 0,
  confirmed: 0,
  noPending: 0,
  failed: 0,
  flagged: 0,
  errors: 0,
  swept: 0,
  noop: 0,
};

describe("PayoutReconciliationService (#492)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Defaults: no claims/rows, no pending winnings, chain quiet.
    mockClaimFindMany.mockResolvedValue([]);
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimCreate.mockImplementation(async ({ data }: any) => ({
      id: "claim-new",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    mockClaimUpdateMany.mockResolvedValue({ count: 1 });
    mockClaimGroupBy.mockResolvedValue([]);
    mockBetGroupBy.mockResolvedValue([]);
    mockUserFindUnique.mockResolvedValue({ id: "user-1", walletAddress: ADDRESS });
    mockGetPendingWinnings.mockResolvedValue(0n);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Candidate sweep (sweepUnclaimedWinnings)
  // ---------------------------------------------------------------------------

  describe("sweepUnclaimedWinnings", () => {
    it("queues a PENDING claim for a user with a resolved bet and no prior claim", async () => {
      const settledAt = new Date(Date.now() - 60 * 60 * 1000);
      mockBetGroupBy.mockResolvedValue([
        { userId: "user-1", _max: { resolvedAt: settledAt } },
      ]);
      // No open claim, and no confirmed claim either.
      mockClaimFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const result = await payoutReconciliationService.sweepUnclaimedWinnings();

      expect(result.swept).toBe(1);
      expect(mockClaimCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          walletAddress: ADDRESS,
          status: ClaimStatus.PENDING,
        }),
      });
    });

    it("skips users that already have an open claim row", async () => {
      mockBetGroupBy.mockResolvedValue([
        { userId: "user-1", _max: { resolvedAt: OLD } },
      ]);
      mockClaimFindFirst.mockResolvedValueOnce({ id: "open-claim" });

      const result = await payoutReconciliationService.sweepUnclaimedWinnings();

      expect(result.swept).toBe(0);
      expect(result.skippedOpen).toBe(1);
      expect(mockClaimCreate).not.toHaveBeenCalled();
    });

    it("skips users whose last confirmed claim is newer than their latest resolution", async () => {
      const resolvedAt = new Date(Date.now() - 60 * 60 * 1000);
      mockBetGroupBy.mockResolvedValue([
        { userId: "user-1", _max: { resolvedAt } },
      ]);
      mockClaimFindFirst
        .mockResolvedValueOnce(null) // no open claim
        .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 1000) }); // confirmed after resolution

      const result = await payoutReconciliationService.sweepUnclaimedWinnings();

      expect(result.swept).toBe(0);
      expect(result.skippedAlreadySwept).toBe(1);
      expect(mockClaimCreate).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PENDING rows
  // ---------------------------------------------------------------------------

  describe("reconcilePendingPayouts — PENDING/FAILED rows", () => {
    it("submits a claim when on-chain winnings exist and marks the row SUBMITTED", async () => {
      mockClaimFindMany.mockResolvedValue([makeRow()]); // PENDING, 0 attempts
      mockGetPendingWinnings.mockResolvedValue(100_000_000n); // 10 XLM
      mockClaimWinnings.mockResolvedValue({
        state: "on-chain-success",
        amount: 10,
        txHash: "0xclaim-abc",
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.checked).toBe(1);
      expect(result.submitted).toBe(1);
      expect(mockClaimWinnings).toHaveBeenCalledWith(ADDRESS);
      expect(mockClaimUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "claim-1",
          status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
        }),
        data: expect.objectContaining({
          status: ClaimStatus.SUBMITTED,
          txHash: "0xclaim-abc",
          amount: 10,
        }),
      });
      expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ address: ADDRESS, txHash: "0xclaim-abc" })
      );
    });

    it("never submits a claim when on-chain pending winnings are zero", async () => {
      mockClaimFindMany.mockResolvedValue([makeRow()]);
      mockGetPendingWinnings.mockResolvedValue(0n);

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.noPending).toBe(1);
      expect(result.submitted).toBe(0);
      expect(mockClaimWinnings).not.toHaveBeenCalled();
      // Row is closed as CONFIRMED with amount 0.
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.CONFIRMED);
      expect(update[0].data.amount).toBe(0);
    });

    it("skips when another claim for the same wallet is already in flight (no double submit)", async () => {
      mockClaimFindMany.mockResolvedValue([makeRow()]);
      mockGetPendingWinnings.mockResolvedValue(50_000_000n);
      mockClaimFindFirst.mockResolvedValue({ id: "other-in-flight" }); // SUBMITTED row

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.noop).toBe(1);
      expect(result.submitted).toBe(0);
      expect(mockClaimWinnings).not.toHaveBeenCalled();
      expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    });

    it("retries a FAILED row whose claim submission previously failed", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.FAILED, attempts: 2 }),
      ]);
      mockGetPendingWinnings.mockResolvedValue(30_000_000n);
      mockClaimWinnings.mockResolvedValue({
        state: "on-chain-success",
        amount: 3,
        txHash: "0xretry",
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.submitted).toBe(1);
      expect(mockClaimWinnings).toHaveBeenCalledWith(ADDRESS);
    });

    it("flags NEEDS_MANUAL_REVIEW once attempts exhaust maxAutoAttempts", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.FAILED, attempts: 4 }), // 4 + 1 = max (5)
      ]);
      mockGetPendingWinnings.mockResolvedValue(10_000_000n);
      mockClaimWinnings.mockRejectedValue(new Error("contract rejected claim"));

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.failed).toBe(0);
      expect(result.flagged).toBe(1);
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.NEEDS_MANUAL_REVIEW);
      expect(update[0].data.attempts).toEqual({ increment: 1 });
      expect(update[0].data.lastError).toContain("contract rejected claim");
    });

    it("counts read errors without changing state", async () => {
      mockClaimFindMany.mockResolvedValue([makeRow()]);
      mockGetPendingWinnings.mockRejectedValue(new Error("RPC down"));

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.errors).toBe(1);
      expect(result.flagged).toBe(0);
      expect(result.noop).toBe(0);
      expect(mockClaimWinnings).not.toHaveBeenCalled();
      expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // SUBMITTED rows (on-chain re-check)
  // ---------------------------------------------------------------------------

  describe("reconcilePendingPayouts — SUBMITTED rows", () => {
    it("confirms a claim whose transaction succeeded on-chain", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xabc", attempts: 0 }),
      ]);
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: true,
        successful: true,
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.confirmed).toBe(1);
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.CONFIRMED);
      expect(update[0].data.claimedAt).toEqual(expect.any(Date));
    });

    it("flags NEEDS_MANUAL_REVIEW when the claim transaction reverted on-chain", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xrevert" }),
      ]);
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: true,
        successful: false,
        error: "ContractError: ClaimNotDue",
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.flagged).toBe(1);
      expect(mockClaimWinnings).not.toHaveBeenCalled();
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.NEEDS_MANUAL_REVIEW);
      expect(update[0].data.lastError).toContain("ClaimNotDue");
    });

    it("marks a dropped tx (not found) as FAILED so it can be safely re-claimed", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xghost", attempts: 0 }),
      ]);
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: false,
        successful: false,
        error: "Transaction not found",
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.failed).toBe(1);
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.FAILED);
      expect(update[0].data.attempts).toEqual({ increment: 1 });
    });

    it("leaves a genuinely in-flight transaction untouched", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xinflight" }),
      ]);
      // confirmed=false with no error => RPC says PENDING.
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: false,
        successful: false,
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.noop).toBe(1);
      expect(result.confirmed).toBe(0);
      expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    });

    it("counts transient chain-check failures as errors without touching state", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xabc" }),
      ]);
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: false,
        successful: false,
        error: "RPC call failed",
      });

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.errors).toBe(1);
      expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    });

    it("resolves a SUBMITTED claim with no txHash when winnings are already cleared", async () => {
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: null, amount: 5 }),
      ]);
      mockGetPendingWinnings.mockResolvedValue(0n);

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.confirmed).toBe(1);
      const update = mockClaimUpdateMany.mock.calls[0];
      expect(update[0].data.status).toBe(ClaimStatus.CONFIRMED);
      // Keeps the amount recorded at submission time.
      expect(update[0].data.amount).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // run() composition and summaries
  // ---------------------------------------------------------------------------

  describe("run() and summaries", () => {
    it("run() sweeps then reconciles and reports both", async () => {
      mockBetGroupBy.mockResolvedValue([
        { userId: "user-1", _max: { resolvedAt: OLD } },
      ]);
      mockClaimFindMany.mockResolvedValue([
        makeRow({ status: ClaimStatus.SUBMITTED, txHash: "0xabc" }),
      ]);
      mockGetTransactionStatus.mockResolvedValue({
        confirmed: true,
        successful: true,
      });

      const result = await payoutReconciliationService.run();

      expect(result.swept).toBe(1);
      expect(result.checked).toBe(1);
      expect(result.confirmed).toBe(1);
    });

    it("summarises current claim counts by status", async () => {
      mockClaimGroupBy.mockResolvedValue([
        { status: ClaimStatus.PENDING, _count: { status: 3 } },
        { status: ClaimStatus.SUBMITTED, _count: { status: 1 } },
        { status: ClaimStatus.NEEDS_MANUAL_REVIEW, _count: { status: 2 } },
      ]);

      const summary = await payoutReconciliationService.getReconciliationSummary();

      expect(summary).toEqual({
        [ClaimStatus.PENDING]: 3,
        [ClaimStatus.SUBMITTED]: 1,
        [ClaimStatus.CONFIRMED]: 0,
        [ClaimStatus.FAILED]: 0,
        [ClaimStatus.NEEDS_MANUAL_REVIEW]: 2,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // No-work fixtures
  // ---------------------------------------------------------------------------

  describe("empty fixtures", () => {
    it("returns an empty result when no claim rows need attention", async () => {
      const result = await payoutReconciliationService.reconcilePendingPayouts();
      expect(result).toEqual(emptyResult);
    });

    it("is race-safe: a failed optimistic update counts as a no-op", async () => {
      mockClaimFindMany.mockResolvedValue([makeRow()]);
      mockGetPendingWinnings.mockResolvedValue(0n);
      mockClaimUpdateMany.mockResolvedValue({ count: 0 }); // status moved under us

      const result = await payoutReconciliationService.reconcilePendingPayouts();

      expect(result.noop).toBe(1);
      expect(result.noPending).toBe(0);
    });
  });
});
