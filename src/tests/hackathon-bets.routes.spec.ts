import { describe, it, expect, beforeEach, afterEach, beforeAll } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { UserRole } from "@prisma/client";
import { createApp } from "../app";
import { generateToken } from "../utils/jwt.util";
import { ExternalServiceError, NotFoundError, ValidationError } from "../utils/errors";

jest.mock("../middleware/rateLimiter.middleware", () => {
  const mockMiddleware = (req: any, res: any, next: any) => next();
  return {
    apiRateLimiter: mockMiddleware,
    writeRateLimiter: mockMiddleware,
    betRateLimiter: mockMiddleware,
    adminRoundRateLimiter: mockMiddleware,
    oracleResolveRateLimiter: mockMiddleware,
    challengeRateLimiter: mockMiddleware,
    connectRateLimiter: mockMiddleware,
    authRateLimiter: mockMiddleware,
    chatMessageRateLimiter: mockMiddleware,
    predictionRateLimiter: mockMiddleware,
    batchPredictionRateLimiter: mockMiddleware,
    batchLeaderboardRateLimiter: mockMiddleware,
  };
});

jest.mock("../services/hackathon.service", () => {
  return {
    __esModule: true,
    default: {
      placeBet: jest.fn().mockResolvedValue(undefined),
      getRounds: jest.fn().mockResolvedValue([]),
      getLeaderboard: jest.fn().mockResolvedValue([]),
      getUserStats: jest.fn().mockResolvedValue({}),
    },
  };
});

const mockRecordUpDownBet = jest.fn();
const mockRecordPrecisionBet = jest.fn();

jest.mock("../services/bet.service", () => ({
  __esModule: true,
  default: {
    recordUpDownBet: (...args: unknown[]) => mockRecordUpDownBet(...args),
    recordPrecisionBet: (...args: unknown[]) => mockRecordPrecisionBet(...args),
    claimWinnings: jest.fn(),
    getBet: jest.fn(),
    getBets: jest.fn(),
    getReconciliationSummary: jest.fn(),
  },
}));

const mockRepositoryPlaceBet = jest.fn();

jest.mock("../repositories", () => ({
  __esModule: true,
  getRepositories: () => ({
    rounds: {
      placeBet: (...args: unknown[]) => mockRepositoryPlaceBet(...args),
    },
  }),
}));

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZ";

/** BET_STUB_MODE=true — bet recorded, no Soroban submission, no txHash. */
const STUB_RESULT = {
  state: "stub",
  betId: "bet-stub-1",
  status: "ACCEPTED",
};

/** BET_STUB_MODE=false — Soroban accepted the bet and returned a tx hash. */
const ONCHAIN_RESULT = {
  state: "submitted",
  betId: "bet-chain-1",
  status: "SUBMITTED",
  txHash: "abc123def456",
};

describe("Round bet routes - BetService integration", () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    token = generateToken("hackathon-user-1", VALID_ADDRESS, UserRole.USER);
  });

  beforeEach(() => {
    // createApp is memoized across tests; recreate so mocks reset cleanly.
    app = createApp();
    mockRepositoryPlaceBet.mockResolvedValue(undefined);
    mockRecordUpDownBet.mockResolvedValue(STUB_RESULT);
    mockRecordPrecisionBet.mockResolvedValue(STUB_RESULT);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/rounds/hackathon/up-down/:id/bet", () => {
    it("places the bet through BetService and returns the real bet payload", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          message: "Bet recorded (stub)",
          state: "stub",
          betId: "bet-stub-1",
          status: "ACCEPTED",
        },
      });

      expect(mockRecordUpDownBet).toHaveBeenCalledTimes(1);
      expect(mockRecordUpDownBet).toHaveBeenCalledWith(
        {
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: "test-round",
        },
        undefined,
      );
    });

    it("still updates the hackathon round store before placing the bet", async () => {
      await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(mockRepositoryPlaceBet).toHaveBeenCalledWith(
        "test-round",
        VALID_ADDRESS,
        10,
        "UP",
      );
    });

    it("returns the on-chain payload with txHash when stub mode is off", async () => {
      mockRecordUpDownBet.mockResolvedValue(ONCHAIN_RESULT);

      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          message: "Bet placed on-chain",
          state: "submitted",
          betId: "bet-chain-1",
          status: "SUBMITTED",
          txHash: "abc123def456",
        },
      });
    });

    it("surfaces an on-chain placement failure as a structured error", async () => {
      mockRecordUpDownBet.mockRejectedValue(
        new ExternalServiceError("Soroban placeBet failed: tx simulation error"),
      );

      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(res.body.message).toMatch(/Soroban placeBet failed/);
    });

    it("returns 404 when BetService reports the round does not exist", async () => {
      mockRecordUpDownBet.mockRejectedValue(
        new NotFoundError("Round missing-round not found"),
      );

      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/missing-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    });

    it("returns 200 when the body omits address (bound to authenticated wallet)", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(mockRecordUpDownBet).toHaveBeenCalledWith(
        expect.objectContaining({ address: VALID_ADDRESS }),
        undefined,
      );
    });

    it("returns 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("No token provided");
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns 401 when Bearer token is malformed (missing token part)", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", "Bearer ")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(401);
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns 401 when the JWT is invalid or expired", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", "Bearer invalid.jwt.token")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid or expired token");
    });

    it("returns 403 when body address does not match the authenticated wallet", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: OTHER_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns 400 for missing required fields (auth passes first)", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid side value", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "INVALID" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for negative amount", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: -5, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for zero amount", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 0, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 when body address is not a valid Stellar format", async () => {
      // bindAuthenticatedWallet runs before validate, so an invalid-format
      // address (which cannot match the Stellar-format JWT wallet) is rejected
      // with 403 earlier than Zod's 400. The 403-mismatch test above already
      // covers the user-impersonation intent (OTHER_ADDRESS).
      const res = await request(app)
        .post("/api/rounds/hackathon/up-down/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: "INVALID_ADDRESS", amount: 10, side: "UP" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
    });
  });

  describe("POST /api/rounds/hackathon/precision/:id/bet", () => {
    it("places the bet through BetService and returns the real bet payload", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          message: "Precision bet recorded (stub)",
          state: "stub",
          betId: "bet-stub-1",
          status: "ACCEPTED",
        },
      });

      expect(mockRecordPrecisionBet).toHaveBeenCalledWith(
        {
          address: VALID_ADDRESS,
          amount: 5,
          predictedPrice: 0.12,
          roundId: "test-round",
        },
        undefined,
      );
    });

    it("returns the on-chain payload with txHash when stub mode is off", async () => {
      mockRecordPrecisionBet.mockResolvedValue(ONCHAIN_RESULT);

      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        message: "Precision bet placed on-chain",
        state: "submitted",
        betId: "bet-chain-1",
        status: "SUBMITTED",
        txHash: "abc123def456",
      });
    });

    it("surfaces an on-chain placement failure as a structured error", async () => {
      mockRecordPrecisionBet.mockRejectedValue(
        new ExternalServiceError("Soroban placePrecisionBet failed"),
      );

      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    });

    it("returns 200 when body omits address (bound to authenticated wallet)", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(mockRecordPrecisionBet).toHaveBeenCalledWith(
        expect.objectContaining({ address: VALID_ADDRESS }),
        undefined,
      );
    });

    it("returns 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("No token provided");
    });

    it("returns 403 when body address does not match the authenticated wallet", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: OTHER_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
    });

    it("returns 400 for missing predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for zero predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for negative predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: -1 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for non-numeric predictedPrice", async () => {
      const res = await request(app)
        .post("/api/rounds/hackathon/precision/test-round/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: "invalid" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/rounds/:id/bet", () => {
    it("dispatches an UP/DOWN payload to recordUpDownBet with the path round id", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          message: "Bet recorded (stub)",
          state: "stub",
          betId: "bet-stub-1",
          status: "ACCEPTED",
        },
      });

      expect(mockRecordUpDownBet).toHaveBeenCalledWith(
        {
          address: VALID_ADDRESS,
          amount: 10,
          side: "UP",
          roundId: "round-1",
        },
        undefined,
      );
      expect(mockRecordPrecisionBet).not.toHaveBeenCalled();
    });

    it("dispatches a Precision payload to recordPrecisionBet with the path round id", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 5, predictedPrice: 0.12 });

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe("Precision bet recorded (stub)");

      expect(mockRecordPrecisionBet).toHaveBeenCalledWith(
        {
          address: VALID_ADDRESS,
          amount: 5,
          predictedPrice: 0.12,
          roundId: "round-1",
        },
        undefined,
      );
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns the on-chain payload with txHash when stub mode is off", async () => {
      mockRecordUpDownBet.mockResolvedValue(ONCHAIN_RESULT);

      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        message: "Bet placed on-chain",
        state: "submitted",
        betId: "bet-chain-1",
        status: "SUBMITTED",
        txHash: "abc123def456",
      });
    });

    it("surfaces an on-chain placement failure as a structured error", async () => {
      mockRecordUpDownBet.mockRejectedValue(
        new ExternalServiceError("Soroban placeBet failed"),
      );

      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    });

    it("returns 400 when the round rejects the bet kind", async () => {
      mockRecordUpDownBet.mockRejectedValue(
        new ValidationError(
          "Round round-1 is a LEGENDS round and does not accept UP_DOWN bets",
        ),
      );

      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .send({ address: VALID_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("No token provided");
      expect(mockRecordUpDownBet).not.toHaveBeenCalled();
    });

    it("returns 403 when body address does not match the authenticated wallet", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: OTHER_ADDRESS, amount: 10, side: "UP" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
    });

    it("returns 400 for empty body (after auth)", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.details).toBeDefined();
    });

    it("returns 400 for missing required fields", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for invalid side value", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: 10, side: "INVALID" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for negative amount", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: VALID_ADDRESS, amount: -5, side: "UP" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 when body address is not a valid Stellar format", async () => {
      const res = await request(app)
        .post("/api/rounds/round-1/bet")
        .set("Authorization", `Bearer ${token}`)
        .send({ address: "INVALID", amount: 10, side: "UP" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/match authenticated user/i);
    });
  });
});
