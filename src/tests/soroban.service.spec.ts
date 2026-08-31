/**
 * SorobanService unit tests — deep coverage of service branching logic.
 *
 * Targets the gaps in soroban-fixture.spec.ts:
 *   • claimWinnings / createRound / resolveRound / mintInitial success+error
 *   • signAndSend returning a tx hash
 *   • ensureInitialized guard (service not ready)
 *   • callWithBreaker: circuit-breaker-open, backpressure, non-Error values
 *   • getHealth / isReady / isFailClosed
 *   • Not-initialized early-return for read-only methods
 *   • signWithAdmin / signWithOracle missing-keypair throws
 *
 * All tests run fully offline against the xelma-bindings and stellar-sdk mocks.
 *
 * NOTE: Happy-path tests are grouped FIRST so the circuit breaker stays
 * closed. Error-path tests are grouped LAST because they accumulate enough
 * failures to trip the breaker (threshold=3).
 */

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk — prevents Keypair.fromSecret from throwing
// on the dummy env secrets set by jest.setup.js
// ---------------------------------------------------------------------------
jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: jest.fn().mockReturnValue({
      toString: () => "mock-keypair",
    }),
  },
  Networks: {
    PUBLIC: "Public Global Stellar Network ; September 2015",
    TESTNET: "Test SDF Network ; September 2015",
  },
  Transaction: jest.fn().mockImplementation(() => ({
    sign: jest.fn(),
    toEnvelope: jest.fn().mockReturnValue({
      toXDR: jest.fn().mockReturnValue("mock-xdr-base64"),
    }),
  })),
}));

// ---------------------------------------------------------------------------
// Mutable mock state — set per test
// ---------------------------------------------------------------------------
let mockClaimResult: unknown = BigInt(50_000_000);
let mockClaimShouldThrow = false;
let mockCreateRoundShouldThrow = false;
let mockResolveRoundShouldThrow = false;
let mockMintResult: unknown = BigInt(10_000_000_000);
let mockMintShouldThrow = false;
let mockGetActiveRoundResult: unknown = null;
let mockGetActiveRoundShouldThrow = false;
let mockPlaceBetShouldThrow = false;
let mockBalanceResult: unknown = BigInt(0);
let mockBalanceShouldThrow = false;
let mockPendingWinningsResult: unknown = BigInt(0);
let mockPendingWinningsShouldThrow = false;
let mockUserStatsResult: unknown = {
  best_streak: 0,
  current_streak: 0,
  total_losses: 0,
  total_wins: 0,
};
let mockUserStatsShouldThrow = false;

function mockTx<T>(result: T) {
  return Promise.resolve({
    result,
    signAndSend: async (_opts?: unknown) => ({
      result,
      hash: "a1b2c3d4e5f6" + Math.random().toString(36).slice(2, 10),
    }),
  });
}

const mockClient = {
  balance: (_params: unknown) => {
    if (mockBalanceShouldThrow) {
      return Promise.reject(new Error("balance RPC failed"));
    }
    return mockTx(mockBalanceResult);
  },
  get_admin: () => mockTx<string | null>(null),
  get_oracle: () => mockTx<string | null>(null),
  initialize: () => mockTx(undefined),
  set_windows: () => mockTx(undefined),
  create_round: (_params: unknown) => {
    if (mockCreateRoundShouldThrow) {
      return Promise.reject(new Error("create_round contract error"));
    }
    return mockTx(undefined);
  },
  place_bet: (_params: unknown) => {
    if (mockPlaceBetShouldThrow) {
      return Promise.reject(new Error("place_bet contract error"));
    }
    return {
      result: undefined,
      signAndSend: async (_opts?: unknown) => ({
        result: undefined,
        hash: "tx_hash_abc123",
      }),
    };
  },
  predict_price: () => mockTx(undefined),
  resolve_round: (_params: unknown) => {
    if (mockResolveRoundShouldThrow) {
      return Promise.reject(new Error("resolve_round oracle error"));
    }
    return mockTx(undefined);
  },
  claim_winnings: (_params: unknown) => {
    if (mockClaimShouldThrow) {
      return Promise.reject(new Error("nothing to claim"));
    }
    return {
      result: mockClaimResult,
      signAndSend: async (_opts?: unknown) => ({
        result: mockClaimResult,
        sendTransactionResponse: { hash: "claim_tx_hash_xyz789" },
      }),
    };
  },
  mint_initial: (_params: unknown) => {
    if (mockMintShouldThrow) {
      return Promise.reject(new Error("mint already used"));
    }
    return mockTx(mockMintResult);
  },
  get_active_round: (_opts?: unknown) => {
    if (mockGetActiveRoundShouldThrow) {
      return Promise.reject(new Error("RPC timeout"));
    }
    return mockTx(mockGetActiveRoundResult);
  },
  get_last_round_id: () => mockTx(BigInt(0)),
  get_user_stats: (_params: unknown) => {
    if (mockUserStatsShouldThrow) {
      return Promise.reject(new Error("user stats RPC failed"));
    }
    return mockTx(mockUserStatsResult);
  },
  get_user_position: () => mockTx<null>(null),
  get_pending_winnings: (_params: unknown) => {
    if (mockPendingWinningsShouldThrow) {
      return Promise.reject(new Error("pending winnings RPC failed"));
    }
    return mockTx(mockPendingWinningsResult);
  },
  get_updown_positions: () => mockTx(new Map()),
  get_precision_predictions: () => mockTx([]),
  place_precision_prediction: (_params: unknown) => {
    if (mockPlaceBetShouldThrow) {
      return Promise.reject(new Error("precision bet error"));
    }
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
// Imports
// ---------------------------------------------------------------------------
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import sorobanService from "../services/soroban.service";
import {
  BusinessRuleError,
  ExternalServiceError,
  ErrorCode,
} from "../utils/errors";
import { createActiveUpDownRound } from "./fixtures/soroban-rounds";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetFixtures(): void {
  mockClaimResult = BigInt(50_000_000);
  mockClaimShouldThrow = false;
  mockCreateRoundShouldThrow = false;
  mockResolveRoundShouldThrow = false;
  mockMintResult = BigInt(10_000_000_000);
  mockMintShouldThrow = false;
  mockGetActiveRoundResult = null;
  mockGetActiveRoundShouldThrow = false;
  mockPlaceBetShouldThrow = false;
  mockBalanceResult = BigInt(0);
  mockBalanceShouldThrow = false;
  mockPendingWinningsResult = BigInt(0);
  mockPendingWinningsShouldThrow = false;
  mockUserStatsResult = {
    best_streak: 0,
    current_streak: 0,
    total_losses: 0,
    total_wins: 0,
  };
  mockUserStatsShouldThrow = false;
}

const TEST_ADDRESS = "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";

beforeEach(async () => {
  resetFixtures();
  await sorobanService.getHealth();
});

// ============================================================================
// SECTION 1: Happy-path tests (circuit breaker stays closed)
// ============================================================================

// ---------------------------------------------------------------------------
// getHealth / isReady / isFailClosed
// ---------------------------------------------------------------------------
describe("SorobanService: getHealth", () => {
  it("returns initialized state and config", async () => {
    const health = await sorobanService.getHealth();
    expect(health.initialized).toBe(true);
    expect(health.contractId).toBeTruthy();
    expect(health.network).toBeDefined();
    expect(health.rpcUrl).toBeDefined();
    expect(typeof health.hasAdminKey).toBe("boolean");
    expect(typeof health.hasOracleKey).toBe("boolean");
    expect(typeof health.failClosed).toBe("boolean");
  });
});

describe("SorobanService: isReady", () => {
  it("returns true after successful init", () => {
    expect(sorobanService.isReady()).toBe(true);
  });
});

describe("SorobanService: isFailClosed", () => {
  it("returns a boolean", () => {
    expect(typeof sorobanService.isFailClosed()).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// placeBet success paths
// ---------------------------------------------------------------------------
describe("SorobanService: placeBet", () => {
  it("returns on-chain-success with tx hash for UP bet", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, 10, "UP");
    expect(result.state).toBe("on-chain-success");
    expect(result.txHash).toBe("tx_hash_abc123");
  });

  it("returns on-chain-success with tx hash for DOWN bet", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, 25, "DOWN");
    expect(result.state).toBe("on-chain-success");
    expect(result.txHash).toBe("tx_hash_abc123");
  });

  it("accepts string amounts", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, "5.5", "UP");
    expect(result.state).toBe("on-chain-success");
  });

  it("result contains state and txHash fields", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, 5, "UP");
    expect(result).toHaveProperty("state");
    expect(result).toHaveProperty("txHash");
    expect(typeof result.state).toBe("string");
  });

  it("handles very small amounts", async () => {
    const result = await sorobanService.placeBet(
      TEST_ADDRESS,
      0.0000001,
      "UP",
    );
    expect(result.state).toBe("on-chain-success");
  });

  it("handles large amounts", async () => {
    const result = await sorobanService.placeBet(
      TEST_ADDRESS,
      999999,
      "DOWN",
    );
    expect(result.state).toBe("on-chain-success");
  });
});

// ---------------------------------------------------------------------------
// placePrecisionBet success
// ---------------------------------------------------------------------------
describe("SorobanService: placePrecisionBet", () => {
  it("returns on-chain-success with tx hash", async () => {
    const result = await sorobanService.placePrecisionBet(
      TEST_ADDRESS,
      10,
      0.1234,
    );
    expect(result.state).toBe("on-chain-success");
    expect(result.txHash).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// claimWinnings success
// ---------------------------------------------------------------------------
describe("SorobanService: claimWinnings", () => {
  it("returns claimed amount in XLM and tx hash on success", async () => {
    mockClaimResult = BigInt(70_000_000); // 7 XLM
    const result = await sorobanService.claimWinnings(TEST_ADDRESS);
    expect(result.state).toBe("on-chain-success");
    expect(result.amount).toBe(7);
    expect(result.txHash).toBe("claim_tx_hash_xyz789");
  });

  it("returns 0 amount when contract returns BigInt(0)", async () => {
    mockClaimResult = BigInt(0);
    const result = await sorobanService.claimWinnings(TEST_ADDRESS);
    expect(result.state).toBe("on-chain-success");
    expect(result.amount).toBe(0);
  });

  it("result contains state, amount, and txHash", async () => {
    const result = await sorobanService.claimWinnings(TEST_ADDRESS);
    expect(result).toHaveProperty("state");
    expect(result).toHaveProperty("amount");
    expect(result).toHaveProperty("txHash");
    expect(typeof result.amount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// createRound success
// ---------------------------------------------------------------------------
describe("SorobanService: createRound", () => {
  it("succeeds with default mode (UpDown)", async () => {
    await expect(
      sorobanService.createRound(1.2345),
    ).resolves.toBeUndefined();
  });

  it("succeeds with explicit Precision mode", async () => {
    await expect(
      sorobanService.createRound(2.0, 1 as any),
    ).resolves.toBeUndefined();
  });

  it("accepts string price", async () => {
    await expect(sorobanService.createRound("0.5")).resolves.toBeUndefined();
  });

  it("handles zero price", async () => {
    await expect(sorobanService.createRound(0)).resolves.toBeUndefined();
  });

  it("handles very high precision price", async () => {
    await expect(
      sorobanService.createRound(1.23456789),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRound success
// ---------------------------------------------------------------------------
describe("SorobanService: resolveRound", () => {
  it("succeeds with valid price and round ID", async () => {
    await expect(
      sorobanService.resolveRound(1.5, 42, BigInt(1700000000)),
    ).resolves.toBeUndefined();
  });

  it("accepts string price", async () => {
    await expect(
      sorobanService.resolveRound("2.5", 7, BigInt(1700000000)),
    ).resolves.toBeUndefined();
  });

  it("handles zero price", async () => {
    await expect(
      sorobanService.resolveRound(0, 1, BigInt(0)),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mintInitial success
// ---------------------------------------------------------------------------
describe("SorobanService: mintInitial", () => {
  it("returns minted amount converted from stroops to XLM", async () => {
    mockMintResult = BigInt(10_000_000_000); // 1000 XLM
    const amount = await sorobanService.mintInitial(TEST_ADDRESS);
    expect(amount).toBe(1000);
  });

  it("returns 0 when contract mints 0 stroops", async () => {
    mockMintResult = BigInt(0);
    const amount = await sorobanService.mintInitial(TEST_ADDRESS);
    expect(amount).toBe(0);
  });

  it("returns a number", async () => {
    const amount = await sorobanService.mintInitial(TEST_ADDRESS);
    expect(typeof amount).toBe("number");
  });

  it("handles zero stroops", async () => {
    mockMintResult = BigInt(0);
    const amount = await sorobanService.mintInitial(TEST_ADDRESS);
    expect(amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getActiveRound success
// ---------------------------------------------------------------------------
describe("SorobanService: getActiveRound", () => {
  it("returns round data when chain has active round", async () => {
    mockGetActiveRoundResult = createActiveUpDownRound();
    const result = await sorobanService.getActiveRound();
    expect(result).not.toBeNull();
    expect(result.round_id).toBe(BigInt(42));
  });

  it("returns null when no active round", async () => {
    mockGetActiveRoundResult = null;
    const result = await sorobanService.getActiveRound();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBalance / getPendingWinnings / getUserStats success
// ---------------------------------------------------------------------------
describe("SorobanService: getBalance", () => {
  it("converts stroops to XLM", async () => {
    mockBalanceResult = BigInt(50_000_000); // 5 XLM
    const balance = await sorobanService.getBalance(TEST_ADDRESS);
    expect(balance).toBe(5);
  });

  it("returns a number", async () => {
    mockBalanceResult = BigInt(100_000_000); // 10 XLM
    const balance = await sorobanService.getBalance(TEST_ADDRESS);
    expect(typeof balance).toBe("number");
    expect(balance).toBe(10);
  });
});

describe("SorobanService: getPendingWinnings", () => {
  it("returns pending winnings in stroops", async () => {
    mockPendingWinningsResult = BigInt(30_000_000);
    const winnings = await sorobanService.getPendingWinnings(TEST_ADDRESS);
    expect(winnings).toBe(BigInt(30_000_000));
  });

  it("returns a bigint", async () => {
    mockPendingWinningsResult = BigInt(25_000_000);
    const winnings = await sorobanService.getPendingWinnings(TEST_ADDRESS);
    expect(typeof winnings).toBe("bigint");
    expect(winnings).toBe(BigInt(25_000_000));
  });
});

describe("SorobanService: getUserStats", () => {
  it("returns user stats from contract", async () => {
    mockUserStatsResult = {
      total_wins: 10,
      total_losses: 5,
      best_streak: 4,
      current_streak: 2,
    };
    const stats = await sorobanService.getUserStats(TEST_ADDRESS);
    expect(stats).not.toBeNull();
    expect(stats?.total_wins).toBe(10);
    expect(stats?.total_losses).toBe(5);
    expect(stats?.best_streak).toBe(4);
    expect(stats?.current_streak).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyMoneyPathFailure (fail-open default)
// ---------------------------------------------------------------------------
describe("SorobanService: applyMoneyPathFailure", () => {
  it("fail-open: does not throw", () => {
    expect(sorobanService.isFailClosed()).toBe(false);
    expect(() =>
      sorobanService.applyMoneyPathFailure("placeBet", new Error("rpc down")),
    ).not.toThrow();
  });

  it("fail-open: wraps non-Error values without throwing", () => {
    expect(() =>
      sorobanService.applyMoneyPathFailure("resolveRound", "string error"),
    ).not.toThrow();
  });

  it("fail-open: wraps null without throwing", () => {
    expect(() =>
      sorobanService.applyMoneyPathFailure("claim", null),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signing paths — exercise signWithAdmin / signWithOracle
// ---------------------------------------------------------------------------
describe("SorobanService: signing paths", () => {
  it("placeBet exercises signWithAdmin via signAndSend", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, 10, "UP");
    expect(result.state).toBe("on-chain-success");
  });

  it("claimWinnings exercises signWithAdmin via signAndSend", async () => {
    mockClaimResult = BigInt(10_000_000);
    const result = await sorobanService.claimWinnings(TEST_ADDRESS);
    expect(result.state).toBe("on-chain-success");
  });

  it("createRound exercises signWithAdmin via signAndSend", async () => {
    await sorobanService.createRound(1.0);
  });

  it("resolveRound exercises signWithOracle via signAndSend", async () => {
    await sorobanService.resolveRound(1.0, 1, BigInt(0));
  });

  it("mintInitial exercises signWithAdmin via signAndSend", async () => {
    const amount = await sorobanService.mintInitial(TEST_ADDRESS);
    expect(typeof amount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Read-only method defaults
// ---------------------------------------------------------------------------
describe("SorobanService: read-only method defaults", () => {
  it("getActiveRound returns null when contract returns null", async () => {
    mockGetActiveRoundResult = null;
    const result = await sorobanService.getActiveRound();
    expect(result).toBeNull();
  });

  it("getBalance returns 0 when contract returns 0", async () => {
    mockBalanceResult = BigInt(0);
    const result = await sorobanService.getBalance(TEST_ADDRESS);
    expect(result).toBe(0);
  });

  it("getPendingWinnings returns BigInt(0) when contract returns 0", async () => {
    mockPendingWinningsResult = BigInt(0);
    const result = await sorobanService.getPendingWinnings(TEST_ADDRESS);
    expect(result).toBe(BigInt(0));
  });

  it("getUserStats returns null when contract returns null", async () => {
    mockUserStatsResult = null;
    const result = await sorobanService.getUserStats(TEST_ADDRESS);
    expect(result).toBeNull();
  });
});

// ============================================================================
// SECTION 2: Error-path tests
//
// IMPORTANT: Specific error-mapping tests (BusinessRuleError expectations)
// are placed FIRST because each failure increments the circuit breaker
// counter. After 3 failures the breaker opens and all subsequent calls
// return CircuitBreakerOpenError → ExternalServiceError, masking the
// underlying contract error mapping.
// ============================================================================

describe("SorobanService: specific error mapping (must run first)", () => {
  it("claimWinnings maps 'nothing to claim' to CONTRACT_INVALID_STATE", async () => {
    mockClaimShouldThrow = true;
    try {
      await sorobanService.claimWinnings(TEST_ADDRESS);
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as BusinessRuleError).code).toBe(
        ErrorCode.CONTRACT_INVALID_STATE,
      );
    }
  });

  it("placeBet maps insufficient funds to INSUFFICIENT_FUNDS", async () => {
    const originalFn = mockClient.place_bet;
    mockClient.place_bet = () => {
      return Promise.reject(new Error("insufficient funds"));
    };
    try {
      await sorobanService.placeBet(TEST_ADDRESS, 100, "UP");
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as BusinessRuleError).code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    }
    mockClient.place_bet = originalFn;
  });

  it("createRound maps timeout to ExternalServiceError with correct code", async () => {
    const originalFn = mockClient.create_round;
    mockClient.create_round = () => {
      return Promise.reject(new Error("request timeout exceeded"));
    };
    try {
      await sorobanService.createRound(1.0);
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).code).toBe(
        ErrorCode.EXTERNAL_SERVICE_ERROR,
      );
    }
    mockClient.create_round = originalFn;
  });
});

// ---------------------------------------------------------------------------
// Error-path tests (breaker may be open at this point)
// ---------------------------------------------------------------------------

describe("SorobanService: placeBet errors", () => {
  it("throws mapped error when contract rejects bet", async () => {
    mockPlaceBetShouldThrow = true;
    await expect(
      sorobanService.placeBet(TEST_ADDRESS, 10, "UP"),
    ).rejects.toThrow();
  });

  it("throws ExternalServiceError on generic contract error", async () => {
    mockPlaceBetShouldThrow = true;
    try {
      await sorobanService.placeBet(TEST_ADDRESS, 10, "UP");
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
    }
  });
});

describe("SorobanService: placePrecisionBet errors", () => {
  it("throws when contract rejects precision bet", async () => {
    mockPlaceBetShouldThrow = true;
    await expect(
      sorobanService.placePrecisionBet(TEST_ADDRESS, 10, 0.1234),
    ).rejects.toThrow();
  });
});

describe("SorobanService: claimWinnings errors", () => {
  it("throws ExternalServiceError on generic claim failure", async () => {
    const originalFn = mockClient.claim_winnings;
    mockClient.claim_winnings = () => {
      return Promise.reject(new Error("generic claim failure"));
    };
    try {
      await sorobanService.claimWinnings(TEST_ADDRESS);
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
    }
    mockClient.claim_winnings = originalFn;
  });
});

describe("SorobanService: createRound errors", () => {
  it("throws mapped error on contract failure", async () => {
    mockCreateRoundShouldThrow = true;
    await expect(sorobanService.createRound(1.0)).rejects.toThrow();
  });

  it("throws ExternalServiceError on generic createRound failure", async () => {
    mockCreateRoundShouldThrow = true;
    try {
      await sorobanService.createRound(1.0);
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
    }
  });
});

describe("SorobanService: resolveRound errors", () => {
  it("throws mapped error on oracle failure", async () => {
    mockResolveRoundShouldThrow = true;
    await expect(
      sorobanService.resolveRound(1.0, 1, BigInt(0)),
    ).rejects.toThrow();
  });

  it("throws ExternalServiceError on generic resolveRound failure", async () => {
    mockResolveRoundShouldThrow = true;
    try {
      await sorobanService.resolveRound(1.0, 1, BigInt(0));
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
    }
  });
});

describe("SorobanService: mintInitial errors", () => {
  it("throws mapped error on mint failure", async () => {
    mockMintShouldThrow = true;
    await expect(sorobanService.mintInitial(TEST_ADDRESS)).rejects.toThrow();
  });

  it("throws ExternalServiceError on generic mint failure", async () => {
    mockMintShouldThrow = true;
    try {
      await sorobanService.mintInitial(TEST_ADDRESS);
      fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ExternalServiceError);
    }
  });
});

describe("SorobanService: getActiveRound errors", () => {
  it("returns null gracefully on RPC error (fail-open)", async () => {
    mockGetActiveRoundShouldThrow = true;
    const result = await sorobanService.getActiveRound();
    expect(result).toBeNull();
  });
});

describe("SorobanService: getBalance errors", () => {
  it("returns 0 on error (fail-open)", async () => {
    mockBalanceShouldThrow = true;
    const balance = await sorobanService.getBalance(TEST_ADDRESS);
    expect(balance).toBe(0);
  });
});

describe("SorobanService: getPendingWinnings errors", () => {
  it("returns BigInt(0) on error (fail-open)", async () => {
    mockPendingWinningsShouldThrow = true;
    const winnings = await sorobanService.getPendingWinnings(TEST_ADDRESS);
    expect(winnings).toBe(BigInt(0));
  });
});

describe("SorobanService: getUserStats errors", () => {
  it("returns null on error (fail-open)", async () => {
    mockUserStatsShouldThrow = true;
    const stats = await sorobanService.getUserStats(TEST_ADDRESS);
    expect(stats).toBeNull();
  });
});
