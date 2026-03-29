import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { RoundLifecycleOutcome } from "../types/round.types";

// Mock Prisma
jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    prediction: {
      update: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
    $transaction: jest.fn((callback: any) => callback()),
  },
}));

// Mock other services
jest.mock("../services/soroban.service", () => ({
  createRound: jest.fn(),
  resolveRound: jest.fn(),
}));

jest.mock("../services/websocket.service", () => ({
  emitRoundStarted: jest.fn(),
  emitRoundLocked: jest.fn(),
  emitRoundResolved: jest.fn(),
  emitNotification: jest.fn(),
}));

jest.mock("../services/notification.service", () => ({
  createNotification: jest.fn(),
}));

jest.mock("../services/education-tip.service", () => ({
  generateTip: jest.fn(),
}));

import { prisma } from "../lib/prisma";
import roundService from "../services/round.service";
import resolutionService from "../services/resolution.service";

describe("Round Idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("lockRound", () => {
    it("should lock an active round and return UPDATED", async () => {
      const roundId = "round-1";
      (prisma.round.findUnique as any).mockResolvedValue({
        id: roundId,
        status: "ACTIVE",
      });

      const outcome = await roundService.lockRound(roundId);

      expect(outcome).toBe(RoundLifecycleOutcome.UPDATED);
      expect(prisma.round.update).toHaveBeenCalledWith({
        where: { id: roundId },
        data: { status: "LOCKED" },
      });
    });

    it("should return ALREADY_LOCKED if the round is already locked", async () => {
      const roundId = "round-1";
      (prisma.round.findUnique as any).mockResolvedValue({
        id: roundId,
        status: "LOCKED",
      });

      const outcome = await roundService.lockRound(roundId);

      expect(outcome).toBe(RoundLifecycleOutcome.ALREADY_LOCKED);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });

    it("should return NO_OP if the round is already resolved", async () => {
      const roundId = "round-1";
      (prisma.round.findUnique as any).mockResolvedValue({
        id: roundId,
        status: "RESOLVED",
      });

      const outcome = await roundService.lockRound(roundId);

      expect(outcome).toBe(RoundLifecycleOutcome.NO_OP);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });

    it("should return NO_OP if the round does not exist", async () => {
      const roundId = "round-non-existent";
      (prisma.round.findUnique as any).mockResolvedValue(null);

      const outcome = await roundService.lockRound(roundId);

      expect(outcome).toBe(RoundLifecycleOutcome.NO_OP);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });
  });

  describe("resolveRound", () => {
    it("should resolve a locked round and return UPDATED", async () => {
      const roundId = "round-1";
      const mockRound = {
        id: roundId,
        status: "LOCKED",
        mode: "UP_DOWN",
        startPrice: 0.1,
        poolUp: 100,
        poolDown: 100,
        predictions: [],
      };
      (prisma.round.findUnique as any).mockResolvedValue(mockRound);

      const result = await resolutionService.resolveRound(roundId, 0.11);

      expect(result.outcome).toBe(RoundLifecycleOutcome.UPDATED);
      expect(prisma.round.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: roundId },
          data: expect.objectContaining({
            status: "RESOLVED",
            endPrice: 0.11,
          }),
        }),
      );
    });

    it("should return ALREADY_RESOLVED if the round is already resolved", async () => {
      const roundId = "round-1";
      const mockRound = {
        id: roundId,
        status: "RESOLVED",
        mode: "UP_DOWN",
      };
      (prisma.round.findUnique as any).mockResolvedValue(mockRound);

      const result = await resolutionService.resolveRound(roundId, 0.11);

      expect(result.outcome).toBe(RoundLifecycleOutcome.ALREADY_RESOLVED);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });

    it("should return NO_OP if the round does not exist", async () => {
      const roundId = "round-non-existent";
      (prisma.round.findUnique as any).mockResolvedValue(null);

      const result = await resolutionService.resolveRound(roundId, 0.11);

      expect(result.outcome).toBe(RoundLifecycleOutcome.NO_OP);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });

    it("should return NO_OP if the round status is CANCELLED", async () => {
      const roundId = "round-1";
      (prisma.round.findUnique as any).mockResolvedValue({
        id: roundId,
        status: "CANCELLED",
      });

      const result = await resolutionService.resolveRound(roundId, 0.11);

      expect(result.outcome).toBe(RoundLifecycleOutcome.NO_OP);
      expect(prisma.round.update).not.toHaveBeenCalled();
    });
  });
});
