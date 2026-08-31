/**
 * Soroban Fixture Integration Tests
 *
 * Unlike existing unit tests that mock soroban.service entirely, this suite
 * provides fixture-based mock data to the underlying xelma-bindings Client and
 * exercises the actual SorobanService class methods (retries, circuit breaker,
 * error mapping, etc.).
 *
 * Two modes:
 *   1. Fixture mode (default, runs in CI) — uses recorded JSON-like fixture data
 *   2. Live testnet mode (optional) — skipped unless SOROBAN_LIVE_TESTNET=true
 *
 * The existing xelma-bindings mock (src/__mocks__/xelma-bindings.ts) is
 * overridden here with fixture-aware implementations so we can test service-level
 * behavior with realistic contract response shapes.
 *
 * Environment variables (set in jest.setup.js):
 *   SOROBAN_CONTRACT_ID  — dummy contract ID for fixture tests
 *   SOROBAN_NETWORK      — testnet
 *   SOROBAN_RPC_URL      — testnet RPC URL
 *   SOROBAN_ADMIN_SECRET — dummy admin keypair
 *   SOROBAN_ORACLE_SECRET — dummy oracle keypair
 *
 * For live testnet tests, set SOROBAN_LIVE_TESTNET=true and provide real credentials.
 */

// ---------------------------------------------------------------------------
// Override the xelma-bindings mock BEFORE any service imports
// ---------------------------------------------------------------------------
import { RoundMode } from "@tevalabs/xelma-bindings";

// Track calls to the mock client for assertion
const mockClientCalls = {
  getActiveRound: 0,
  placeBet: 0,
  placePrecisionBet: 0,
  getUserStats: 0,
  getBalance: 0,
  getPendingWinnings: 0,
};

function mockTx<T>(result: T) {
  return Promise.resolve({
    result,
    signAndSend: async (_opts?: unknown) => ({ result }),
  });
}

// Mutable fixture state — set per test
let mockGetActiveRoundResult: unknown = null;
let mockGetActiveRoundShouldThrow = false;
let mockPlaceBetResult: unknown = undefined;
let mockPlaceBetShouldThrow = false;
let mockGetUserStatsResult: unknown = {
  best_streak: 0,
  current_streak: 0,
  total_losses: 0,
  total_wins: 0,
};
let mockBalanceResult: unknown = BigInt(0);
let mockPendingWinningsResult: unknown = BigInt(0);

const mockClient = {
  balance: () => {
    mockClientCalls.getBalance++;
    return mockTx(mockBalanceResult);
  },
  get_admin: () => mockTx<string | null>(null),
  get_oracle: () => mockTx<string | null>(null),
  initialize: () => mockTx(undefined),
  set_windows: () => mockTx(undefined),
  create_round: () => mockTx(undefined),
  place_bet: () => {
    mockClientCalls.placeBet++;
    if (mockPlaceBetShouldThrow) {
      return Promise.reject(new Error("Fixture: Soroban contract error"));
    }
    return mockTx(mockPlaceBetResult);
  },
  predict_price: () => mockTx(undefined),
  resolve_round: () => mockTx(undefined),
  claim_winnings: () => mockTx(BigInt(0)),
  mint_initial: () => mockTx(BigInt(0)),
  get_active_round: () => {
    mockClientCalls.getActiveRound++;
    if (mockGetActiveRoundShouldThrow) {
      return Promise.reject(
        new Error("Fixture: RPC timeout fetching active round"),
      );
    }
    return mockTx(mockGetActiveRoundResult);
  },
  get_last_round_id: () => mockTx(BigInt(0)),
  get_user_stats: () => {
    mockClientCalls.getUserStats++;
    return mockTx(mockGetUserStatsResult);
  },
  get_user_position: () => mockTx<null>(null),
  get_pending_winnings: () => {
    mockClientCalls.getPendingWinnings++;
    return mockTx(mockPendingWinningsResult);
  },
  get_updown_positions: () => mockTx(new Map()),
  get_precision_predictions: () => mockTx([]),
  place_precision_prediction: () => {
    mockClientCalls.placePrecisionBet++;
    return mockTx(undefined);
  },
  get_user_precision_prediction: () => mockTx<null>(null),
};

jest.mock("@tevalabs/xelma-bindings", () => ({
  BetSide: {
    Up: { tag: "Up" as const, values: undefined },
    Down: { tag: "Down" as const, values: undefined },
  },
  RoundMode: {
    UpDown: 0,
    Precision: 1,
  },
  Client: jest.fn().mockImplementation(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Imports (soroban.service will use the fixture-based xelma-bindings mock)
// ---------------------------------------------------------------------------
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
process.env.SOROBAN_CONTRACT_ID = process.env.SOROBAN_CONTRACT_ID || "CFixtureContractId";
process.env.SOROBAN_ADMIN_SECRET = "";
process.env.SOROBAN_ORACLE_SECRET = "";
import sorobanService from "../services/soroban.service";
import {
  createActiveUpDownRound,
  createActiveLegendsRound,
  createFixtureUserStats,
} from "./fixtures/soroban-rounds";

/** Reset fixture state before each test */
function resetFixtures(): void {
  mockGetActiveRoundResult = null;
  mockGetActiveRoundShouldThrow = false;
  mockPlaceBetResult = undefined;
  mockPlaceBetShouldThrow = false;
  mockGetUserStatsResult = {
    best_streak: 0,
    current_streak: 0,
    total_losses: 0,
    total_wins: 0,
  };
  mockBalanceResult = BigInt(0);
  mockPendingWinningsResult = BigInt(0);
  mockClientCalls.getActiveRound = 0;
  mockClientCalls.placeBet = 0;
  mockClientCalls.placePrecisionBet = 0;
  mockClientCalls.getUserStats = 0;
  mockClientCalls.getBalance = 0;
  mockClientCalls.getPendingWinnings = 0;
}

beforeEach(async () => {
  resetFixtures();
  // Ensure the service singleton has finished its async init()
  await sorobanService.getHealth();
});

// ============================================================================
// Fixture-based test suite (runs in CI)
// ============================================================================

describe("Soroban Fixture Integration: getActiveRound", () => {
  it("returns parsed UP/DOWN round data when chain returns active round", async () => {
    const fixtureRound = createActiveUpDownRound();
    mockGetActiveRoundResult = fixtureRound;

    const result = await sorobanService.getActiveRound();

    expect(result).not.toBeNull();
    expect(result?.round_id).toBe(BigInt(42));
    expect(result?.mode).toBe(RoundMode.UpDown);
    expect(result?.price_start).toBe(BigInt(12345));
    expect(result?.pool_up).toBe(BigInt(50_000_000_0));
    expect(result?.pool_down).toBe(BigInt(25_000_000_0));
    expect(mockClientCalls.getActiveRound).toBe(1);
  });

  it("returns parsed LEGENDS round data for Precision mode", async () => {
    mockGetActiveRoundResult = createActiveLegendsRound();

    const result = await sorobanService.getActiveRound();

    expect(result).not.toBeNull();
    expect(result?.mode).toBe(RoundMode.Precision);
    expect(result?.price_start).toBe(BigInt(10000));
    expect(mockClientCalls.getActiveRound).toBe(1);
  });

  it("returns null when no active round exists on chain", async () => {
    mockGetActiveRoundResult = null;

    const result = await sorobanService.getActiveRound();

    expect(result).toBeNull();
    expect(mockClientCalls.getActiveRound).toBe(1);
  });

  it("returns null gracefully when RPC call errors (fail-open policy)", async () => {
    mockGetActiveRoundShouldThrow = true;

    const result = await sorobanService.getActiveRound();

    expect(result).toBeNull();
    expect(mockClientCalls.getActiveRound).toBeGreaterThan(0);
  });
});

describe("Soroban Fixture Integration: placeBet", () => {
  it("successfully places an UP/DOWN bet and returns on-chain state", async () => {
    mockPlaceBetResult = undefined;

    const result = await sorobanService.placeBet(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
      10,
      "UP",
    );

    expect(result).toEqual({ state: "on-chain-success" });
    expect(mockClientCalls.placeBet).toBe(1);
  });

  it("successfully places a DOWN bet", async () => {
    mockPlaceBetResult = undefined;

    const result = await sorobanService.placeBet(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
      25,
      "DOWN",
    );

    expect(result).toEqual({ state: "on-chain-success" });
    expect(mockClientCalls.placeBet).toBe(1);
  });

  it("throws when contract rejects the bet", async () => {
    mockPlaceBetShouldThrow = true;

    await expect(
      sorobanService.placeBet(
        "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
        10,
        "UP",
      ),
    ).rejects.toThrow();
  });
});

describe("Soroban Fixture Integration: placePrecisionBet", () => {
  it("successfully places a Precision bet", async () => {
    const result = await sorobanService.placePrecisionBet(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
      10,
      0.1234,
    );

    expect(result).toEqual({ state: "on-chain-success" });
    expect(mockClientCalls.placePrecisionBet).toBe(1);
  });
});

describe("Soroban Fixture Integration: getUserStats", () => {
  it("returns user stats from contract", async () => {
    mockGetUserStatsResult = createFixtureUserStats({
      total_wins: 15,
      total_losses: 7,
      best_streak: 6,
      current_streak: 3,
    });

    const result = await sorobanService.getUserStats(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).not.toBeNull();
    expect(result?.total_wins).toBe(15);
    expect(result?.total_losses).toBe(7);
    expect(result?.best_streak).toBe(6);
    expect(result?.current_streak).toBe(3);
    expect(mockClientCalls.getUserStats).toBe(1);
  });

  it("returns null when contract returns null stats", async () => {
    mockGetUserStatsResult = null;

    const result = await sorobanService.getUserStats(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).toBeNull();
    expect(mockClientCalls.getUserStats).toBe(1);
  });
});

describe("Soroban Fixture Integration: getBalance", () => {
  it("returns user balance from contract (converted from stroops)", async () => {
    mockBalanceResult = BigInt(10_000_000_000); // 1000 XLM

    const result = await sorobanService.getBalance(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).toBe(1000);
    expect(mockClientCalls.getBalance).toBe(1);
  });

  it("returns 0 when no balance exists", async () => {
    mockBalanceResult = BigInt(0);

    const result = await sorobanService.getBalance(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).toBe(0);
  });
});

describe("Soroban Fixture Integration: getPendingWinnings", () => {
  it("returns pending winnings from contract", async () => {
    mockPendingWinningsResult = BigInt(5_000_000_000);

    const result = await sorobanService.getPendingWinnings(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).toBe(BigInt(5_000_000_000));
    expect(mockClientCalls.getPendingWinnings).toBe(1);
  });

  it("returns 0 when no pending winnings", async () => {
    mockPendingWinningsResult = BigInt(0);

    const result = await sorobanService.getPendingWinnings(
      "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
    );

    expect(result).toBe(BigInt(0));
  });
});

// ============================================================================
// Live testnet tests (gated behind SOROBAN_LIVE_TESTNET env flag)
// ============================================================================

const testnetDescribe =
  process.env.SOROBAN_LIVE_TESTNET === "true" ? describe : describe.skip;

testnetDescribe(
  "Soroban Live Testnet (SOROBAN_LIVE_TESTNET=true)",
  () => {
    it("connects to the testnet and fetches the active round", async () => {
      const health = await sorobanService.getHealth();
      expect(health.initialized).toBe(true);

      const round = await sorobanService.getActiveRound();
      expect(round === null || typeof round === "object").toBe(true);
    });

    it("fetches user stats for a known testnet address", async () => {
      const testAddress = process.env.SOROBAN_TEST_USER_ADDRESS || "";
      if (!testAddress) {
        return;
      }

      const stats = await sorobanService.getUserStats(testAddress);
      expect(stats === null || typeof stats === "object").toBe(true);
    });
  },
);
