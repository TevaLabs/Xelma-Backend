import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../lib/prisma", () => {
  const bet = {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    groupBy: jest.fn(),
  };
  const user = {
    findUnique: jest.fn(),
    create: jest.fn(),
  };
  const round = {
    findFirst: jest.fn(),
  };
  const outboxEvent = {
    create: jest.fn(),
  };
  return {
    prisma: {
      bet,
      user,
      round,
      outboxEvent,
      $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn({ bet, user, round, outboxEvent })),
    },
  };
});

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
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
    emitBetAccepted: jest.fn(),
    emitBetFailed: jest.fn(),
    emitBetReconciled: jest.fn(),
    emitClaimAccepted: jest.fn(),
  },
}));

jest.mock("../services/websocket.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    replayEmit: jest.fn(),
  },
}));

jest.mock("../services/outbox.service", () => ({
  __esModule: true,
  default: {
    processOutbox: jest.fn(),
    cleanupProcessed: jest.fn(),
  },
  BetAcceptedOutboxPayload: {},
  BetConfirmedOutboxPayload: {},
  BetResolvedOutboxPayload: {},
  BetFailedOutboxPayload: {},
  OutboxEventType: {
    BET_ACCEPTED: 'BET_ACCEPTED',
    BET_CONFIRMED: 'BET_CONFIRMED',
    BET_RESOLVED: 'BET_RESOLVED',
    BET_FAILED: 'BET_FAILED',
    NOTIFICATION_CREATE: 'NOTIFICATION_CREATE',
    WEBSOCKET_EMIT: 'WEBSOCKET_EMIT',
  },
  OutboxEventStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    PROCESSED: 'PROCESSED',
    FAILED: 'FAILED',
  },
}));

import betService from "../services/bet.service";
import betAuditService from "../services/bet-audit.service";
import sorobanService from "../services/soroban.service";
import { prisma } from "../lib/prisma";
import { BetStatus, BetMode } from "@prisma/client";

const ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
const OTHER_ADDRESS = "GZZZZZZ1234567890ABCDEF1234567890ABCDEF1234567890";

const mockBetCreate = prisma.bet.create as jest.Mock;
const mockBetFindUnique = prisma.bet.findUnique as jest.Mock;
const mockBetFindFirst = prisma.bet.findFirst as jest.Mock;
const mockBetFindMany = prisma.bet.findMany as jest.Mock;
const mockBetUpdate = prisma.bet.update as jest.Mock;
const mockBetGroupBy = prisma.bet.groupBy as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserCreate = prisma.user.create as jest.Mock;
const mockRoundFindFirst = prisma.round.findFirst as jest.Mock;
const mockOutboxCreate = prisma.outboxEvent.create as jest.Mock;
const mockTransaction = prisma.$transaction as jest.Mock;

describe("Bet reconciliation lifecycle (#403)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BET_STUB_MODE = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ----------------------------------------------------------------
  // Stub bets
  // ----------------------------------------------------------------

  describe("stub bets", () => {
    it("persists an UP/DOWN stub bet with ACCEPTED status and no txHash", async () => {
      const userId = "user-1";
      const betId = "bet-1";
      const createdBet = {
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue(createdBet);
      mockBetFindUnique.mockResolvedValue(createdBet);
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

      const result = await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "UP",
      });

      const bet = await betService.getBet(result.betId);

      expect(bet).toBeDefined();
      expect(bet!.status).toBe(BetStatus.ACCEPTED);
      expect(bet!.txHash).toBeNull();
      expect(bet!.submittedAt).toBeNull();
      expect(bet!.mode).toBe(BetMode.UP_DOWN);
      expect(bet!.side).toBe("UP");
      expect(bet!.amount).toBe(10);
      expect(bet!.userId).toBe(userId);
      expect(bet!.createdAt).toEqual(expect.any(Date));
    });

    it("persists a Precision stub bet with ACCEPTED status", async () => {
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      const precisionBet = {
        id: "bet-1",
        userId,
        roundId: "round-1",
        mode: BetMode.PRECISION,
        side: null,
        amount: 5,
        predictedPrice: 0.12,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockBetCreate.mockResolvedValue(precisionBet);
      mockBetFindUnique.mockResolvedValue(precisionBet);
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

      const result = await betService.recordPrecisionBet({
        address: ADDRESS,
        amount: 5,
        predictedPrice: 0.12,
      });

      const bet = await betService.getBet(result.betId);

      expect(bet!.status).toBe(BetStatus.ACCEPTED);
      expect(bet!.mode).toBe(BetMode.PRECISION);
      expect(bet!.predictedPrice).toBe(0.12);
      expect(bet!.txHash).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Stub -> chain upgrade (reconcileBet)
  // ----------------------------------------------------------------

  describe("reconcileBet — stub to on-chain upgrade", () => {
    it("upgrades a stub bet with a txHash and marks it CONFIRMED", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

      await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "UP",
      });

      // Now reconcile
      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xdeadbeef",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });

      const reconciled = await betService.reconcileBet(betId, "0xdeadbeef");

      expect(reconciled).toBeDefined();
      expect(reconciled!.status).toBe(BetStatus.CONFIRMED);
      expect(reconciled!.txHash).toBe("0xdeadbeef");
      expect(reconciled!.confirmedAt).toEqual(expect.any(Date));
    });

    it("preserves the original record instead of creating a new one", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      const originalBet = {
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };
      mockBetCreate.mockResolvedValue(originalBet);
      mockBetFindUnique.mockResolvedValue(originalBet);
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

      await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "UP",
      });

      const before = await betService.getBet(betId)!;

      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xdeadbeef",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });

      await betService.reconcileBet(betId, "0xdeadbeef");
      const after = await betService.getBet(betId)!;

      expect(after.id).toBe(before.id);
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.amount).toBe(before.amount);
    });

    it("emits a BET_RECONCILED audit event carrying the txHash", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });

      await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "UP",
      });

      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xdeadbeef",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });

      await betService.reconcileBet(betId, "0xdeadbeef");

      expect(betAuditService.emitBetReconciled).toHaveBeenCalledWith(
        expect.objectContaining({
          betId,
          address: ADDRESS,
          mode: "UP_DOWN",
          status: BetStatus.CONFIRMED,
          txHash: "0xdeadbeef",
        })
      );
    });

    it("returns null for an unknown bet id without throwing", async () => {
      mockBetFindUnique.mockResolvedValue(null);

      expect(await betService.reconcileBet("bet-does-not-exist", "0xabc")).toBeNull();
      expect(betAuditService.emitBetReconciled).not.toHaveBeenCalled();
    });

    it("clears a previous failure when a failed bet is later reconciled", async () => {
      process.env.BET_STUB_MODE = "false";
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });

      // First call: bet creation fails
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockRejectedValue(
        new Error("RPC unavailable")
      );

      await expect(
        betService.recordUpDownBet({ address: ADDRESS, amount: 10, side: "UP" })
      ).rejects.toThrow("RPC unavailable");

      // Verify bet was marked FAILED
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.FAILED,
        txHash: null,
        failureReason: "RPC unavailable",
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Now reconcile the failed bet
      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.FAILED,
        txHash: null,
        failureReason: "RPC unavailable",
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xlanded",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });

      const reconciled = await betService.reconcileBet(betId, "0xlanded");

      expect(reconciled!.status).toBe(BetStatus.CONFIRMED);
      expect(reconciled!.txHash).toBe("0xlanded");
      expect(reconciled!.failureReason).toBeNull();
      expect(reconciled!.failedAt).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // On-chain success
  // ----------------------------------------------------------------

  describe("on-chain submissions", () => {
    beforeEach(() => {
      process.env.BET_STUB_MODE = "false";
    });

    it("marks a successful UP/DOWN submission CONFIRMED with its txHash", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.SUBMITTED,
        txHash: "0xabc",
        failureReason: null,
        submittedAt: new Date(),
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xabc",
      });

      const result = await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "DOWN",
      });

      const bet = await betService.getBet(result.betId)!;

      expect(result.status).toBe(BetStatus.SUBMITTED);
      expect(bet.status).toBe(BetStatus.SUBMITTED);
      expect(bet.txHash).toBe("0xabc");
      expect(bet.submittedAt).toEqual(expect.any(Date));
    });

    it("marks a successful Precision submission CONFIRMED with its txHash", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.PRECISION,
        side: null,
        amount: 5,
        predictedPrice: 0.12,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.PRECISION,
        side: null,
        amount: 5,
        predictedPrice: 0.12,
        status: BetStatus.SUBMITTED,
        txHash: "0x789",
        failureReason: null,
        submittedAt: new Date(),
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0x789",
      });

      const result = await betService.recordPrecisionBet({
        address: ADDRESS,
        amount: 5,
        predictedPrice: 0.12,
      });

      const bet = await betService.getBet(result.betId)!;

      expect(result.status).toBe(BetStatus.SUBMITTED);
      expect(bet.status).toBe(BetStatus.SUBMITTED);
      expect(bet.txHash).toBe("0x789");
    });

    it("leaves the bet SUBMITTED when the chain call returns no txHash", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.SUBMITTED,
        txHash: null,
        failureReason: null,
        submittedAt: new Date(),
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
      });

      const result = await betService.recordUpDownBet({
        address: ADDRESS,
        amount: 10,
        side: "UP",
      });

      const bet = await betService.getBet(result.betId)!;

      expect(bet.status).toBe(BetStatus.SUBMITTED);
      expect(bet.txHash).toBeNull();
      expect(bet.submittedAt).toEqual(expect.any(Date));
      expect(bet.confirmedAt).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // On-chain failure
  // ----------------------------------------------------------------

  describe("failed on-chain submissions", () => {
    beforeEach(() => {
      process.env.BET_STUB_MODE = "false";
    });

    it("marks the bet FAILED and records the reason", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockRejectedValue(
        new Error("Contract error: insufficient balance")
      );

      await expect(
        betService.recordUpDownBet({ address: ADDRESS, amount: 10, side: "UP" })
      ).rejects.toThrow("Contract error: insufficient balance");

      mockBetFindMany.mockResolvedValue([
        {
          id: betId,
          userId,
          roundId: "round-1",
          mode: BetMode.UP_DOWN,
          side: "UP",
          amount: 10,
          predictedPrice: null,
          status: BetStatus.FAILED,
          txHash: null,
          failureReason: "Contract error: insufficient balance",
          submittedAt: null,
          confirmedAt: null,
          resolvedAt: null,
          failedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const bets = await betService.getBets({ userId });

      expect(bets).toHaveLength(1);
      expect(bets[0].status).toBe(BetStatus.FAILED);
      expect(bets[0].failureReason).toBe("Contract error: insufficient balance");
      expect(bets[0].failedAt).toEqual(expect.any(Date));
      expect(bets[0].txHash).toBeNull();
    });

    it("still rethrows so the caller sees the failure", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.PRECISION,
        side: null,
        amount: 5,
        predictedPrice: 0.12,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placePrecisionBet as jest.Mock).mockRejectedValue(
        new Error("RPC unavailable")
      );

      await expect(
        betService.recordPrecisionBet({
          address: ADDRESS,
          amount: 5,
          predictedPrice: 0.12,
        })
      ).rejects.toThrow("RPC unavailable");
    });

    it("emits BET_FAILED and never BET_ACCEPTED", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const failedBet = {
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 10,
        predictedPrice: null,
        status: BetStatus.FAILED,
        txHash: null,
        failureReason: "RPC unavailable",
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockBetFindUnique.mockResolvedValue(failedBet);
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockRejectedValue(
        new Error("RPC unavailable")
      );

      await expect(
        betService.recordUpDownBet({ address: ADDRESS, amount: 10, side: "UP" })
      ).rejects.toThrow();

      const failedCall = (mockOutboxCreate as jest.Mock).mock.calls.find(
        (c: any[]) => c[0]?.data?.eventType === "BET_FAILED"
      );
      expect(failedCall).toBeDefined();
      expect(failedCall[0].data.payload.failureReason).toBe("RPC unavailable");
      expect(failedCall[0].data.payload.mode).toBe("UP_DOWN");
      expect(betAuditService.emitBetAccepted).not.toHaveBeenCalled();
    });

    it("does not lose the record when the chain call fails", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 42,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      ;(sorobanService.placeBet as jest.Mock).mockRejectedValue(
        new Error("boom")
      );

      await expect(
        betService.recordUpDownBet({ address: ADDRESS, amount: 42, side: "UP" })
      ).rejects.toThrow();

      mockBetFindMany.mockResolvedValue([
        {
          id: betId,
          userId,
          roundId: "round-1",
          mode: BetMode.UP_DOWN,
          side: "UP",
          amount: 42,
          predictedPrice: null,
          status: BetStatus.FAILED,
          txHash: null,
          failureReason: "boom",
          submittedAt: null,
          confirmedAt: null,
          resolvedAt: null,
          failedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const bets = await betService.getBets({ status: BetStatus.FAILED });

      expect(bets).toHaveLength(1);
      expect(bets[0].amount).toBe(42);
    });
  });

  // ----------------------------------------------------------------
  // Read API
  // ----------------------------------------------------------------

  describe("read API", () => {
    beforeEach(() => {
      process.env.BET_STUB_MODE = "true";
    });

    it("filters by userId", async () => {
      const userId1 = "user-1";
      const userId2 = "user-2";
      mockUserFindUnique.mockResolvedValue({ id: userId1, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: "bet-1",
        userId: userId1,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 1, side: "UP" });

      mockUserFindUnique.mockResolvedValue({ id: userId1, walletAddress: ADDRESS });
      mockBetCreate.mockResolvedValue({
        id: "bet-2",
        userId: userId1,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "DOWN",
        amount: 2,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 2, side: "DOWN" });

      mockUserFindUnique.mockResolvedValue({ id: userId2, walletAddress: OTHER_ADDRESS });
      mockBetCreate.mockResolvedValue({
        id: "bet-3",
        userId: userId2,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 3,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-3" });
      await betService.recordUpDownBet({ address: OTHER_ADDRESS, amount: 3, side: "UP" });

      mockBetFindMany.mockResolvedValue([
        { id: "bet-2", userId: userId1, amount: 2, createdAt: new Date() },
        { id: "bet-1", userId: userId1, amount: 1, createdAt: new Date() },
      ]);
      expect(await betService.getBets({ userId: userId1 })).toHaveLength(2);
      mockBetFindMany.mockResolvedValue([
        { id: "bet-3", userId: userId2, amount: 3, createdAt: new Date() },
      ]);
      expect(await betService.getBets({ userId: userId2 })).toHaveLength(1);
    });

    it("filters by status", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      const userId2 = "user-2";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 1, side: "UP" });

      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xaaa",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });

      await betService.reconcileBet(betId, "0xaaa");

      mockBetFindMany.mockResolvedValue([
        { id: betId, userId, status: BetStatus.CONFIRMED, createdAt: new Date() },
      ]);
      expect(await betService.getBets({ status: BetStatus.CONFIRMED })).toHaveLength(1);
      mockBetFindMany.mockResolvedValue([
        { id: "bet-2", userId, status: BetStatus.ACCEPTED, createdAt: new Date() },
        { id: "bet-3", userId: userId2, status: BetStatus.ACCEPTED, createdAt: new Date() },
      ]);
      expect(await betService.getBets({ status: BetStatus.ACCEPTED })).toHaveLength(2);
      mockBetFindMany.mockResolvedValue([]);
      expect(await betService.getBets({ status: BetStatus.FAILED })).toHaveLength(0);
    });

    it("filters by round", async () => {
      mockBetFindMany.mockResolvedValue([
        { id: "bet-1", roundId: "round-1" },
        { id: "bet-2", roundId: "round-1" },
        { id: "bet-3", roundId: "round-1" },
      ]);
      expect(await betService.getBets({ roundId: "round-1" })).toHaveLength(3);
      mockBetFindMany.mockResolvedValue([]);
      expect(await betService.getBets({ roundId: "no-such-round" })).toHaveLength(0);
    });

    it("summarises bets per reconciliation status", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 1, side: "UP" });

      mockBetCreate.mockResolvedValue({
        id: "bet-2",
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "DOWN",
        amount: 2,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-2" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 2, side: "DOWN" });

      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBetUpdate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.CONFIRMED,
        txHash: "0xaaa",
        failureReason: null,
        failedAt: null,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-3" });
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });

      await betService.reconcileBet(betId, "0xaaa");

      mockBetGroupBy.mockResolvedValue([
        { status: BetStatus.ACCEPTED, _count: { status: 2 } },
        { status: BetStatus.CONFIRMED, _count: { status: 1 } },
        { status: BetStatus.FAILED, _count: { status: 0 } },
        { status: BetStatus.SUBMITTED, _count: { status: 0 } },
        { status: BetStatus.RESOLVED, _count: { status: 0 } },
      ]);

      expect(await betService.getReconciliationSummary()).toEqual({
        [BetStatus.ACCEPTED]: 2,
        [BetStatus.SUBMITTED]: 0,
        [BetStatus.CONFIRMED]: 1,
        [BetStatus.RESOLVED]: 0,
        [BetStatus.FAILED]: 0,
      });
    });

    it("returns copies so callers cannot mutate stored records", async () => {
      const betId = "bet-1";
      const userId = "user-1";
      mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress: ADDRESS });
      mockRoundFindFirst.mockResolvedValue({ id: "round-1" });
      mockBetCreate.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
      await betService.recordUpDownBet({ address: ADDRESS, amount: 1, side: "UP" });

      mockBetFindMany.mockResolvedValue([
        { id: betId, userId, status: BetStatus.ACCEPTED },
      ]);
      const bets = await betService.getBets({ userId });
      bets[0].status = BetStatus.CONFIRMED;

      mockBetFindUnique.mockResolvedValue({
        id: betId,
        userId,
        roundId: "round-1",
        mode: BetMode.UP_DOWN,
        side: "UP",
        amount: 1,
        predictedPrice: null,
        status: BetStatus.ACCEPTED,
        txHash: null,
        failureReason: null,
        submittedAt: null,
        confirmedAt: null,
        resolvedAt: null,
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect((await betService.getBet(betId))!.status).toBe(BetStatus.ACCEPTED);
    });

    it("returns null for an unknown bet id", async () => {
      mockBetFindUnique.mockResolvedValue(null);
      expect(await betService.getBet("bet-nope")).toBeNull();
    });
  });
});