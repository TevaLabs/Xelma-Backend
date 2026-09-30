/**
 * Offline SorobanService suite (#645).
 *
 * Covers the service branching that fixture tests cannot see:
 *   • placeBet / claimWinnings / getActiveRound success mapping ({ state, txHash })
 *   • error mapping (BusinessRuleError vs ExternalServiceError)
 *   • fail-open vs fail-closed money-path policy for the same operations
 *
 * Everything runs against a configurable in-process mock of
 * `@tevalabs/xelma-bindings` — no Soroban RPC, no network, no database.
 */

// ---------------------------------------------------------------------------
// @stellar/stellar-sdk — keep Keypair.fromSecret from throwing on dummy secrets.
// ---------------------------------------------------------------------------
jest.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: jest.fn().mockReturnValue({ toString: () => "mock-keypair" }),
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
// Configurable mock state for the generated client. Set per test.
// ---------------------------------------------------------------------------
let failPlaceBet = false;
let failClaim = false;
let failActiveRound = false;

function mockTx<T>(result: T) {
  return Promise.resolve({
    result,
    signAndSend: async (_opts?: unknown) => ({ result, hash: "tx-hash-default" }),
  });
}

const mockClient = {
  place_bet: (_params: unknown) =>
    failPlaceBet
      ? Promise.reject(new Error("place_bet contract error"))
      : {
          result: undefined,
          signAndSend: async (_opts?: unknown) => ({
            result: undefined,
            hash: "tx-up-down-hash",
          }),
        },
  place_precision_prediction: (_params: unknown) => mockTx(undefined),
  claim_winnings: (_params: unknown) =>
    failClaim
      ? Promise.reject(new Error("nothing to claim"))
      : {
          result: BigInt(30_000_000),
          signAndSend: async (_opts?: unknown) => ({
            result: BigInt(30_000_000),
            sendTransactionResponse: { hash: "claim-hash" },
          }),
        },
  get_active_round: (_opts?: unknown) =>
    failActiveRound
      ? Promise.reject(new Error("RPC timeout"))
      : mockTx({ round_id: BigInt(7), mode: 0 }),
  create_round: (_params: unknown) => mockTx(undefined),
  resolve_round: (_params: unknown) => mockTx(undefined),
  mint_initial: (_params: unknown) => mockTx(BigInt(0)),
  balance: (_params: unknown) => mockTx(BigInt(0)),
  get_user_stats: (_params: unknown) =>
    mockTx({ total_wins: 0, total_losses: 0, best_streak: 0, current_streak: 0 }),
  get_pending_winnings: (_params: unknown) => mockTx(BigInt(0)),
  get_user_position: (_params: unknown) => mockTx<null>(null),
};

jest.mock("@tevalabs/xelma-bindings", () => ({
  BetSide: {
    Up: { tag: "Up" as const, values: undefined },
    Down: { tag: "Down" as const, values: undefined },
  },
  RoundMode: { UpDown: 0, Precision: 1 },
  Client: jest.fn().mockImplementation(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Mock config so `failClosed` can be toggled per test without resetModules.
// ---------------------------------------------------------------------------
jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  const base = actual.default ?? actual;
  return {
    __esModule: true,
    default: {
      ...base,
      soroban: {
        ...base.soroban,
        contractId: "CCJZ5DGZBW5JRZYPZ6J6V3JZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z",
        adminSecret: "SAJDSFHKJDFHKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJD",
        oracleSecret: "SBJDSFHKJDFHKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJDSHFKJD",
        failClosed: false,
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it } from "@jest/globals";
import sorobanService from "../services/soroban.service";
import config from "../config";
import { BusinessRuleError, ErrorCode, ExternalServiceError } from "../utils/errors";

const TEST_ADDRESS = "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";

beforeEach(async () => {
  failPlaceBet = false;
  failClaim = false;
  failActiveRound = false;
  config.soroban.failClosed = false;
  await sorobanService.getHealth(); // await init()
});

describe("SorobanService offline: success mapping (#645)", () => {
  it("placeBet maps a confirmed contract call to { state, txHash }", async () => {
    const result = await sorobanService.placeBet(TEST_ADDRESS, 10, "UP");
    expect(result).toEqual({ state: "on-chain-success", txHash: "tx-up-down-hash" });
  });

  it("claimWinnings maps stroops to XLM and surfaces the tx hash", async () => {
    const result = await sorobanService.claimWinnings(TEST_ADDRESS);
    expect(result.state).toBe("on-chain-success");
    expect(result.amount).toBe(3); // 30_000_000 stroops
    expect(result.txHash).toBe("claim-hash");
  });

  it("getActiveRound returns the raw chain round", async () => {
    const round = await sorobanService.getActiveRound();
    expect(round).not.toBeNull();
    expect(round.round_id).toBe(BigInt(7));
  });
});

describe("SorobanService offline: error mapping (#645)", () => {
  // Each rejection increments the circuit breaker (threshold 3), so the
  // contract-error cases run first and are limited to one per operation.

  it("claimWinnings maps 'nothing to claim' to CONTRACT_INVALID_STATE", async () => {
    failClaim = true;
    try {
      await sorobanService.claimWinnings(TEST_ADDRESS);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessRuleError);
      expect((err as BusinessRuleError).code).toBe(ErrorCode.CONTRACT_INVALID_STATE);
    }
  });

  it("placeBet wraps a generic contract error as ExternalServiceError", async () => {
    failPlaceBet = true;
    await expect(sorobanService.placeBet(TEST_ADDRESS, 10, "UP")).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it("getActiveRound returns null on error (read-only is always fail-open)", async () => {
    failActiveRound = true;
    await expect(sorobanService.getActiveRound()).resolves.toBeNull();
  });
});

describe("SorobanService offline: fail-open vs fail-closed policy (#645)", () => {
  it("fail-open: applyMoneyPathFailure logs and does not throw", () => {
    config.soroban.failClosed = false;
    expect(sorobanService.isFailClosed()).toBe(false);
    expect(() =>
      sorobanService.applyMoneyPathFailure("placeBet", new Error("rpc down")),
    ).not.toThrow();
  });

  it("fail-closed: applyMoneyPathFailure rethrows so the money path aborts", () => {
    config.soroban.failClosed = true;
    expect(sorobanService.isFailClosed()).toBe(true);
    expect(() =>
      sorobanService.applyMoneyPathFailure("claimWinnings", new Error("chain down")),
    ).toThrow(/chain down/);
  });

  it("fail-closed: non-Error values are wrapped and rethrown", () => {
    config.soroban.failClosed = true;
    expect(() =>
      sorobanService.applyMoneyPathFailure("resolveRound", "oracle failed"),
    ).toThrow(/oracle failed/);
  });
});
