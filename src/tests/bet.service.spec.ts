import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import betService from "../services/bet.service";

// ----------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
  },
}));

import sorobanService from "../services/soroban.service";
import betAuditService from "../services/bet-audit.service";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

// ================================================================
// BetService mode selection tests
// ================================================================

describe("BetService - mode selection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // --------------------------------------------------------------
  // UP/DOWN bets
  // --------------------------------------------------------------

  describe("recordUpDownBet", () => {
    it("returns stub state when BET_STUB_MODE=true", async () => {
      process.env.BET_STUB_MODE = "true";

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "UP",
      });

      expect(result).toEqual({ state: "stub" });
      expect(sorobanService.placeBet).not.toHaveBeenCalled();
      expect(betAuditService.emitBetAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "UP_DOWN", result: "stub" })
      );
    });

    it("calls SorobanService when BET_STUB_MODE=false", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xabc",
      });

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 10,
        side: "DOWN",
      });

      expect(result).toEqual({ state: "on-chain-success", txHash: "0xabc" });
      expect(sorobanService.placeBet).toHaveBeenCalledWith(VALID_ADDRESS, 10, "DOWN");
      expect(betAuditService.emitBetAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "UP_DOWN", result: "on-chain-success" })
      );
    });

    it("treats unset BET_STUB_MODE as on-chain", async () => {
      delete process.env.BET_STUB_MODE;
      (sorobanService.placeBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xdef",
      });

      const result = await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 5,
        side: "UP",
      });

      expect(sorobanService.placeBet).toHaveBeenCalled();
      expect(result.state).toBe("on-chain-success");
    });
  });

  // --------------------------------------------------------------
  // Precision bets
  // --------------------------------------------------------------

  describe("recordPrecisionBet", () => {
    it("returns stub state when BET_STUB_MODE=true", async () => {
      process.env.BET_STUB_MODE = "true";

      const result = await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 5,
        predictedPrice: 0.12,
      });

      expect(result).toEqual({ state: "stub" });
      expect(sorobanService.placePrecisionBet).not.toHaveBeenCalled();
      expect(betAuditService.emitBetAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "PRECISION", result: "stub" })
      );
    });

    it("calls SorobanService when BET_STUB_MODE=false", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0x789",
      });

      const result = await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 5,
        predictedPrice: 0.12,
      });

      expect(result).toEqual({ state: "on-chain-success", txHash: "0x789" });
      expect(sorobanService.placePrecisionBet).toHaveBeenCalledWith(VALID_ADDRESS, 5, 0.12);
      expect(betAuditService.emitBetAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "PRECISION", result: "on-chain-success" })
      );
    });

    it("treats unset BET_STUB_MODE as on-chain", async () => {
      delete process.env.BET_STUB_MODE;
      (sorobanService.placePrecisionBet as jest.Mock).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xghi",
      });

      const result = await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 10,
        predictedPrice: 0.15,
      });

      expect(sorobanService.placePrecisionBet).toHaveBeenCalled();
      expect(result.state).toBe("on-chain-success");
    });
  });
});
