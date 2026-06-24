import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { RoundMode } from "@tevalabs/xelma-bindings";

const mockGetActiveRound = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getActiveRound: (...args: any[]) => mockGetActiveRound(...args),
    isReady: jest.fn().mockReturnValue(true),
  },
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
  },
}));

jest.mock("../config", () => ({
  __esModule: true,
  default: {
    app: { roundsMockMode: false },
  },
}));

describe("RoundService.getActiveRoundsWithFallback", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetActiveRound.mockReset();
    mockFindMany.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns soroban round when chain data is available", async () => {
    mockGetActiveRound.mockResolvedValueOnce({
      round_id: BigInt(9),
      mode: RoundMode.UpDown,
      price_start: BigInt(12000),
      pool_up: BigInt(10_000_000),
      pool_down: BigInt(5_000_000),
      start_ledger: 1,
      bet_end_ledger: 2,
      end_ledger: 3,
    });

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getActiveRoundsWithFallback();

    expect(result.source).toBe("soroban");
    expect(result.rounds[0].sorobanRoundId).toBe("9");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("falls back to database when soroban returns null", async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);
    mockFindMany.mockResolvedValueOnce([
      {
        id: "db-round-1",
        mode: "UP_DOWN",
        status: "ACTIVE",
        startPrice: 0.5,
      },
    ]);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getActiveRoundsWithFallback();

    expect(result.source).toBe("database");
    expect(result.rounds[0].id).toBe("db-round-1");
    expect(result.rounds[0].source).toBe("database");
  });
});
