import { beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { Express } from "express";
import request from "supertest";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";

const USER_A_ID = "batch-user-a-id";
const USER_B_ID = "batch-user-b-id";
const ROUND_1_ID = "batch-round-1-id";
const ROUND_2_ID = "batch-round-2-id";

const mockUserFindUnique = jest.fn();
const mockSubmitBatchPredictions = jest.fn();
const mockGetBatchUserPositions = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/prediction.service", () => ({
  __esModule: true,
  default: {
    submitBatchPredictions: (...args: any[]) =>
      mockSubmitBatchPredictions(...args),
  },
}));

jest.mock("../services/leaderboard.service", () => ({
  getLeaderboard: jest.fn(),
  getBatchUserPositions: (...args: any[]) => mockGetBatchUserPositions(...args),
}));

describe("Batch Predictions Routes", () => {
  let app: Express;
  let userA: { id: string; walletAddress: string };
  let userAToken: string;

  beforeAll(async () => {
    app = createApp();

    userA = {
      id: USER_A_ID,
      walletAddress: "GBATCH_USER_A_TEST_AAAAAAAAAAAAAAAA",
    };
    userAToken = generateToken(userA.id, userA.walletAddress);

    mockUserFindUnique.mockResolvedValue(userA);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/predictions/batch-submit", () => {
    it("should submit batch predictions successfully", async () => {
      const batchRequest = {
        predictions: [
          {
            roundId: ROUND_1_ID,
            amount: 10,
            side: "UP",
          },
          {
            roundId: ROUND_2_ID,
            amount: 15,
            side: "DOWN",
          },
        ],
      };

      const mockResult = {
        success: true,
        results: [
          {
            index: 0,
            success: true,
            prediction: {
              id: "pred-1",
              roundId: ROUND_1_ID,
              amount: 10,
              side: "UP",
              priceRange: null,
              createdAt: "2026-01-29T00:00:00.000Z",
            },
          },
          {
            index: 1,
            success: true,
            prediction: {
              id: "pred-2",
              roundId: ROUND_2_ID,
              amount: 15,
              side: "DOWN",
              priceRange: null,
              createdAt: "2026-01-29T00:00:00.000Z",
            },
          },
        ],
      };

      mockSubmitBatchPredictions.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .set("Authorization", `Bearer ${userAToken}`)
        .send(batchRequest);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(mockSubmitBatchPredictions).toHaveBeenCalledWith(
        USER_A_ID,
        batchRequest.predictions,
      );
    });

    it("should handle partial success in batch predictions", async () => {
      const batchRequest = {
        predictions: [
          {
            roundId: ROUND_1_ID,
            amount: 10,
            side: "UP",
          },
          {
            roundId: "invalid-round",
            amount: 15,
            side: "DOWN",
          },
        ],
      };

      const mockResult = {
        success: true,
        results: [
          {
            index: 0,
            success: true,
            prediction: {
              id: "pred-1",
              roundId: ROUND_1_ID,
              amount: 10,
              side: "UP",
              priceRange: null,
              createdAt: "2026-01-29T00:00:00.000Z",
            },
          },
          {
            index: 1,
            success: false,
            error: "Round not found",
          },
        ],
      };

      mockSubmitBatchPredictions.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .set("Authorization", `Bearer ${userAToken}`)
        .send(batchRequest);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0].success).toBe(true);
      expect(response.body.results[1].success).toBe(false);
    });

    it("should reject empty batch", async () => {
      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ predictions: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("ValidationError");
      expect(response.body.message).toContain(
        "At least one prediction is required",
      );
    });

    it("should reject batch with duplicate round IDs", async () => {
      const batchRequest = {
        predictions: [
          {
            roundId: ROUND_1_ID,
            amount: 10,
            side: "UP",
          },
          {
            roundId: ROUND_1_ID,
            amount: 15,
            side: "DOWN",
          },
        ],
      };

      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .set("Authorization", `Bearer ${userAToken}`)
        .send(batchRequest);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("ValidationError");
      expect(response.body.message).toContain(
        "Duplicate round IDs are not allowed",
      );
    });

    it("should reject batch exceeding size limit", async () => {
      const predictions = Array(51)
        .fill(null)
        .map((_, i) => ({
          roundId: `round-${i}`,
          amount: 10,
          side: "UP",
        }));

      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ predictions });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("ValidationError");
      expect(response.body.message).toContain(
        "Maximum 50 predictions per batch",
      );
    });

    it("should require authentication", async () => {
      const batchRequest = {
        predictions: [
          {
            roundId: ROUND_1_ID,
            amount: 10,
            side: "UP",
          },
        ],
      };

      const response = await request(app)
        .post("/api/predictions/batch-submit")
        .send(batchRequest);

      expect(response.status).toBe(401);
    });
  });
});

describe("Batch Leaderboard Routes", () => {
  let app: Express;
  let userA: { id: string; walletAddress: string };
  let userAToken: string;

  beforeAll(async () => {
    app = createApp();

    userA = {
      id: USER_A_ID,
      walletAddress: "GBATCH_USER_A_TEST_AAAAAAAAAAAAAAAA",
    };
    userAToken = generateToken(userA.id, userA.walletAddress);

    mockUserFindUnique.mockResolvedValue(userA);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/leaderboard/batch", () => {
    it("should get batch user positions successfully", async () => {
      const batchRequest = {
        userIds: [USER_A_ID, USER_B_ID],
      };

      const mockResult = [
        {
          userId: USER_A_ID,
          position: {
            rank: 15,
            userId: USER_A_ID,
            walletAddress: "GBRPY...4B",
            totalEarnings: 125.5,
            totalPredictions: 42,
            accuracy: 73.81,
            modeStats: {
              upDown: {
                wins: 20,
                losses: 10,
                earnings: 85.25,
                accuracy: 66.67,
              },
              legends: { wins: 12, losses: 8, earnings: 40.25, accuracy: 60.0 },
            },
          },
        },
        {
          userId: USER_B_ID,
          position: {
            rank: 25,
            userId: USER_B_ID,
            walletAddress: "GBRPY...5C",
            totalEarnings: 85.25,
            totalPredictions: 30,
            accuracy: 66.67,
            modeStats: {
              upDown: { wins: 15, losses: 5, earnings: 65.25, accuracy: 75.0 },
              legends: { wins: 5, losses: 5, earnings: 20.0, accuracy: 50.0 },
            },
          },
        },
      ];

      mockGetBatchUserPositions.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/leaderboard/batch")
        .set("Authorization", `Bearer ${userAToken}`)
        .send(batchRequest);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.results).toEqual(mockResult);
      expect(mockGetBatchUserPositions).toHaveBeenCalledWith(
        batchRequest.userIds,
      );
    });

    it("should handle partial success in batch user positions", async () => {
      const batchRequest = {
        userIds: [USER_A_ID, "nonexistent-user"],
      };

      const mockResult = [
        {
          userId: USER_A_ID,
          position: {
            rank: 15,
            userId: USER_A_ID,
            walletAddress: "GBRPY...4B",
            totalEarnings: 125.5,
            totalPredictions: 42,
            accuracy: 73.81,
            modeStats: {
              upDown: {
                wins: 20,
                losses: 10,
                earnings: 85.25,
                accuracy: 66.67,
              },
              legends: { wins: 12, losses: 8, earnings: 40.25, accuracy: 60.0 },
            },
          },
        },
        {
          userId: "nonexistent-user",
          error: "User not found",
        },
      ];

      mockGetBatchUserPositions.mockResolvedValue(mockResult);

      const response = await request(app)
        .post("/api/leaderboard/batch")
        .set("Authorization", `Bearer ${userAToken}`)
        .send(batchRequest);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0].position).toBeDefined();
      expect(response.body.results[1].error).toBeDefined();
    });

    it("should reject empty userIds array", async () => {
      const response = await request(app)
        .post("/api/leaderboard/batch")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ userIds: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("ValidationError");
      expect(response.body.message).toContain(
        "At least one user ID is required",
      );
    });

    it("should reject batch exceeding size limit", async () => {
      const userIds = Array(101)
        .fill(null)
        .map((_, i) => `user-${i}`);

      const response = await request(app)
        .post("/api/leaderboard/batch")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ userIds });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("ValidationError");
      expect(response.body.message).toContain("Maximum 100 user IDs per query");
    });

    it("should require authentication", async () => {
      const batchRequest = {
        userIds: [USER_A_ID],
      };

      const response = await request(app)
        .post("/api/leaderboard/batch")
        .send(batchRequest);

      expect(response.status).toBe(401);
    });
  });
});
