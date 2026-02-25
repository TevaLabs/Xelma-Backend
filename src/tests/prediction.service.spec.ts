/**
 * Covers submitPrediction success/failure and getUserPredictions / getRoundPredictions.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { PredictionService } from "../services/prediction.service";

jest.mock("../lib/prisma", () => ({
  prisma: {
    round: { findUnique: jest.fn(), update: jest.fn() },
    prediction: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: { placeBet: jest.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../lib/prisma";

const predictionService = new PredictionService();
const mockRoundFindUnique = prisma.round.findUnique as jest.Mock;
const mockPredictionFindUnique = prisma.prediction.findUnique as jest.Mock;
const mockPredictionCreate = prisma.prediction.create as jest.Mock;
const mockPredictionFindMany = prisma.prediction.findMany as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockRoundUpdate = prisma.round.update as jest.Mock;

const userId = "user-1";
const roundId = "round-1";

describe("PredictionService (Issue #78)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("submitPrediction", () => {
    describe("failures", () => {
      it("should throw when round not found", async () => {
        mockRoundFindUnique.mockResolvedValue(null);

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, "UP")
        ).rejects.toThrow("Round not found");

        expect(mockRoundFindUnique).toHaveBeenCalledWith({ where: { id: roundId } });
      });

      it("should throw when round is not ACTIVE", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "RESOLVED",
        });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, "UP")
        ).rejects.toThrow("Round is not active");
      });

      it("should throw when user already has a prediction for the round", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "ACTIVE",
        });
        mockPredictionFindUnique.mockResolvedValue({ id: "existing-pred" });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, "UP")
        ).rejects.toThrow("User has already placed a prediction for this round");
      });

      it("should throw when user not found", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "ACTIVE",
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue(null);

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, "UP")
        ).rejects.toThrow("User not found");
      });

      it("should throw when insufficient balance", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "ACTIVE",
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 50,
        });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, "UP")
        ).rejects.toThrow("Insufficient balance");
      });

      it("should throw when UP_DOWN mode but side not provided", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "ACTIVE",
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 1000,
        });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100)
        ).rejects.toThrow("Side (UP/DOWN) is required for UP_DOWN mode");
      });

      it("should throw when LEGENDS mode but priceRange not provided", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "LEGENDS",
          status: "ACTIVE",
          priceRanges: [{ min: 1, max: 2, pool: 0 }],
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 1000,
        });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, undefined)
        ).rejects.toThrow("Price range is required for LEGENDS mode");
      });

      it("should throw when LEGENDS mode has invalid price range", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "LEGENDS",
          status: "ACTIVE",
          priceRanges: [{ min: 1, max: 2, pool: 0 }],
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 1000,
        });

        await expect(
          predictionService.submitPrediction(userId, roundId, 100, undefined, {
            min: 5,
            max: 10,
          })
        ).rejects.toThrow("Invalid price range");
      });
    });

    describe("success - UP_DOWN mode", () => {
      it("should create prediction and update balance and pools", async () => {
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "UP_DOWN",
          status: "ACTIVE",
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 1000,
        });
        const created = {
          id: "pred-1",
          roundId,
          userId,
          amount: 100,
          side: "UP",
          createdAt: new Date(),
        };
        mockPredictionCreate.mockResolvedValue(created);
        mockUserUpdate.mockResolvedValue({});
        mockRoundUpdate.mockResolvedValue({});

        const result = await predictionService.submitPrediction(
          userId,
          roundId,
          100,
          "UP"
        );

        expect(result).toEqual(created);
        expect(mockPredictionCreate).toHaveBeenCalledWith({
          data: {
            roundId,
            userId,
            amount: 100,
            side: "UP",
          },
        });
        expect(mockUserUpdate).toHaveBeenCalledWith({
          where: { id: userId },
          data: { virtualBalance: 900 },
        });
        expect(mockRoundUpdate).toHaveBeenCalledWith({
          where: { id: roundId },
          data: { poolUp: { increment: 100 } },
        });
      });
    });

    describe("success - LEGENDS mode", () => {
      it("should create prediction and update balance and price range pool", async () => {
        const priceRanges = [
          { min: 1, max: 2, pool: 0 },
          { min: 2, max: 3, pool: 0 },
        ];
        mockRoundFindUnique.mockResolvedValue({
          id: roundId,
          mode: "LEGENDS",
          status: "ACTIVE",
          priceRanges,
        });
        mockPredictionFindUnique.mockResolvedValue(null);
        mockUserFindUnique.mockResolvedValue({
          id: userId,
          walletAddress: "GXXX",
          virtualBalance: 500,
        });
        const created = {
          id: "pred-2",
          roundId,
          userId,
          amount: 50,
          priceRange: { min: 1, max: 2 },
          createdAt: new Date(),
        };
        mockPredictionCreate.mockResolvedValue(created);
        mockUserUpdate.mockResolvedValue({});
        mockRoundUpdate.mockResolvedValue({});

        const result = await predictionService.submitPrediction(
          userId,
          roundId,
          50,
          undefined,
          { min: 1, max: 2 }
        );

        expect(result).toEqual(created);
        expect(mockPredictionCreate).toHaveBeenCalledWith({
          data: {
            roundId,
            userId,
            amount: 50,
            priceRange: { min: 1, max: 2 },
          },
        });
        expect(mockRoundUpdate).toHaveBeenCalledWith({
          where: { id: roundId },
          data: {
            priceRanges: [
              { min: 1, max: 2, pool: 50 },
              { min: 2, max: 3, pool: 0 },
            ],
          },
        });
      });
    });
  });

  describe("getUserPredictions", () => {
    it("should return user predictions ordered by createdAt desc", async () => {
      const list = [
        { id: "p1", userId, roundId, amount: 10, round: {} },
      ];
      mockPredictionFindMany.mockResolvedValue(list);

      const result = await predictionService.getUserPredictions(userId);

      expect(result).toEqual(list);
      expect(mockPredictionFindMany).toHaveBeenCalledWith({
        where: { userId },
        include: { round: true },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should throw on DB error", async () => {
      mockPredictionFindMany.mockRejectedValue(new Error("DB error"));

      await expect(predictionService.getUserPredictions(userId)).rejects.toThrow(
        "DB error"
      );
    });
  });

  describe("getRoundPredictions", () => {
    it("should return round predictions with user select", async () => {
      const list = [
        { id: "p1", roundId, userId, user: { id: userId, walletAddress: "GX" } },
      ];
      mockPredictionFindMany.mockResolvedValue(list);

      const result = await predictionService.getRoundPredictions(roundId);

      expect(result).toEqual(list);
      expect(mockPredictionFindMany).toHaveBeenCalledWith({
        where: { roundId },
        include: {
          user: { select: { id: true, walletAddress: true } },
        },
      });
    });
  });
});
