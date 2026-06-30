import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { RoundMode } from "@tevalabs/xelma-bindings";

const mockGetActiveRound = jest.fn();
const mockFindMany = jest.fn();
const mockGetMockRounds = jest.fn();

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

jest.mock("../data/mockData", () => ({
  __esModule: true,
  getMockRounds: (...args: any[]) => mockGetMockRounds(...args),
}));

jest.mock("../config", () => ({
  __esModule: true,
  default: {
    app: { roundsMockMode: false },
  },
}));

const MOCK_SOROBAN_ROUND = {
  round_id: BigInt(9),
  mode: RoundMode.UpDown,
  price_start: BigInt(12000),
  pool_up: BigInt(10_000_000),
  pool_down: BigInt(5_000_000),
  start_ledger: 1,
  bet_end_ledger: 2,
  end_ledger: 3,
};

const MOCK_DB_ROUNDS = [
  { id: "db-round-1", mode: "UP_DOWN", status: "ACTIVE", startPrice: 0.5 },
];

const MOCK_DATA_ROUNDS = [
  { id: "mock-1", asset: "XLM", mode: "updown", status: "live", startPrice: 0.5, poolUp: 100, poolDown: 200, closesAt: new Date().toISOString() },
];

describe("RoundService.getRoundsForApi", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetActiveRound.mockReset();
    mockFindMany.mockReset();
    mockGetMockRounds.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns soroban round when chain data is available", async () => {
    mockGetActiveRound.mockResolvedValueOnce(MOCK_SOROBAN_ROUND);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getRoundsForApi();

    expect(result.source).toBe("soroban");
    expect(result.rounds[0].sorobanRoundId).toBe("9");
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockGetMockRounds).not.toHaveBeenCalled();
  });

  it("falls back to database when soroban returns null", async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);
    mockFindMany.mockResolvedValueOnce(MOCK_DB_ROUNDS);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getRoundsForApi();

    expect(result.source).toBe("database");
    expect(result.rounds[0].id).toBe("db-round-1");
    expect(result.rounds[0].source).toBe("database");
    expect(mockGetMockRounds).not.toHaveBeenCalled();
  });

  it("falls back to mock data when soroban and database are unavailable", async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);
    mockFindMany.mockResolvedValueOnce([]);
    mockGetMockRounds.mockResolvedValueOnce(MOCK_DATA_ROUNDS);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getRoundsForApi();

    expect(result.source).toBe("mock");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].id).toBe("mock-1");
  });

  it("falls back to mock data when database throws", async () => {
    mockGetActiveRound.mockResolvedValueOnce(null);
    mockFindMany.mockRejectedValueOnce(new Error("DB connection lost"));
    mockGetMockRounds.mockResolvedValueOnce(MOCK_DATA_ROUNDS);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getRoundsForApi();

    expect(result.source).toBe("mock");
    expect(result.rounds[0].id).toBe("mock-1");
  });

  it("skips soroban and returns mock data when roundsMockMode is true", async () => {
    jest.resetModules();
    jest.doMock("../config", () => ({
      __esModule: true,
      default: {
        app: { roundsMockMode: true },
      },
    }));
    mockGetMockRounds.mockResolvedValueOnce(MOCK_DATA_ROUNDS);

    const { default: roundService } = await import("../services/round.service");
    const result = await roundService.getRoundsForApi();

    expect(result.source).toBe("mock");
    expect(mockGetActiveRound).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  describe("getActiveRoundsWithFallback (deprecated alias)", () => {
    it("delegates to getRoundsForApi", async () => {
      mockGetActiveRound.mockResolvedValueOnce(MOCK_SOROBAN_ROUND);

      const { default: roundService } = await import("../services/round.service");
      const result = await roundService.getActiveRoundsWithFallback();

      expect(result.source).toBe("soroban");
      expect(result.rounds[0].sorobanRoundId).toBe("9");
    });
  });
});
