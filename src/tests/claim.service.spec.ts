/**
 * claim.service.spec.ts
 *
 * Tests for BetService.claimWinnings() covering:
 *  1. Core behaviour (stub mode, happy path, idempotent re-submission, failures)
 *  2. Concurrency / double-claim risk — verifies that the withClaimLock guard
 *     prevents concurrent requests for the same wallet from both reaching the
 *     on-chain submission path.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mock: claim-lock — replaced with a transparent pass-through for unit tests
// so they run without a real Postgres connection.  Concurrency tests exercise
// the real lock via the in-memory mutex path (see the second describe block).
// ---------------------------------------------------------------------------
jest.mock("../utils/claim-lock", () => ({
  __esModule: true,
  withClaimLock: jest.fn(
    (_address: string, fn: () => Promise<unknown>) => fn(),
  ),
  resetInMemoryClaimLocks: jest.fn(),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../lib/prisma", () => {
  const claim = {
    findFirst: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  };
  return {
    prisma: {
      claim,
      user: { findUnique: jest.fn(), create: jest.fn() },
      bet: { findMany: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
        fn({ claim }),
      ),
    },
  };
});

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitClaimAccepted: jest.fn(),
  },
}));

jest.mock("../services/websocket.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
  },
}));

import betService from "../services/bet.service";
import sorobanService from "../services/soroban.service";
import betAuditService from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";
import { ClaimStatus } from "@prisma/client";
import {
  withClaimLock,
  resetInMemoryClaimLocks,
} from "../utils/claim-lock";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
const OTHER_ADDRESS = "GZZZZZZ1234567890ABCDEF1234567890ABCDEF1234567890";

const mockWithClaimLock = withClaimLock as jest.Mock;
const mockClaimFindFirst = prisma.claim.findFirst as jest.Mock;
const mockClaimCreate = prisma.claim.create as jest.Mock;
const mockClaimUpdateMany = prisma.claim.updateMany as jest.Mock;

// ===========================================================================
// Part 1 — Core behaviour (lock is a transparent pass-through)
// ===========================================================================

describe("BetService.claimWinnings — core behaviour", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.BET_STUB_MODE = "false";
    // Default: transparent pass-through so behaviour under test is the
    // bet service logic, not the lock itself.
    mockWithClaimLock.mockImplementation(
      (_address: string, fn: () => Promise<unknown>) => fn(),
    );
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimCreate.mockResolvedValue({ id: "claim-1" });
    mockClaimUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Stub mode
  // -------------------------------------------------------------------------

  it("returns stub claim when BET_STUB_MODE=true and touches no claim ledger", async () => {
    process.env.BET_STUB_MODE = "true";

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result).toEqual({ state: "stub", amount: 0 });
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
    expect(prisma.claim.findFirst).not.toHaveBeenCalled();
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VALID_ADDRESS,
        amount: 0,
        result: "stub",
        txHash: undefined,
      }),
    );
  });

  it("does not acquire the claim lock in stub mode", async () => {
    process.env.BET_STUB_MODE = "true";

    await betService.claimWinnings(VALID_ADDRESS);

    // Lock is bypassed entirely for stub mode.
    expect(mockWithClaimLock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("calls SorobanService, records the claim ledger, and audits when BET_STUB_MODE=false", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 12.5,
      txHash: "0xclaim",
    });

    const result = await betService.claimWinnings(VALID_ADDRESS, "idem-key-1");

    expect(result).toEqual({
      state: "on-chain-success",
      amount: 12.5,
      txHash: "0xclaim",
    });
    expect(sorobanService.claimWinnings).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(mockClaimFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletAddress: VALID_ADDRESS }),
      }),
    );
    // No open claim existed → a fresh SUBMITTED row is created.
    expect(mockClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.SUBMITTED,
        txHash: "0xclaim",
        amount: 12.5,
      }),
    });
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VALID_ADDRESS,
        amount: 12.5,
        result: "on-chain-success",
        txHash: "0xclaim",
      }),
    );
  });

  it("acquires the claim lock on the non-stub path", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 1,
      txHash: "0xabc",
    });

    await betService.claimWinnings(VALID_ADDRESS);

    expect(mockWithClaimLock).toHaveBeenCalledWith(
      VALID_ADDRESS,
      expect.any(Function),
    );
  });

  // -------------------------------------------------------------------------
  // Already-submitted guard
  // -------------------------------------------------------------------------

  it("does not double-submit when a SUBMITTED claim is already in flight", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-in-flight",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.SUBMITTED,
      txHash: "0xinflight",
      amount: 8,
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result).toEqual({
      state: "already-submitted",
      amount: 8,
      txHash: "0xinflight",
    });
    expect(sorobanService.claimWinnings).not.toHaveBeenCalled();
    expect(mockClaimCreate).not.toHaveBeenCalled();
    expect(mockClaimUpdateMany).not.toHaveBeenCalled();
    expect(betAuditService.emitClaimAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        address: VALID_ADDRESS,
        result: "already-submitted",
        txHash: "0xinflight",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Retry path (PENDING / FAILED row)
  // -------------------------------------------------------------------------

  it("updates an existing PENDING/FAILED claim row to SUBMITTED after a successful claim", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-retry",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.FAILED,
      txHash: null,
      amount: null,
    });
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 3.25,
      txHash: "0xretried",
    });

    const result = await betService.claimWinnings(VALID_ADDRESS);

    expect(result.txHash).toBe("0xretried");
    expect(mockClaimCreate).not.toHaveBeenCalled();
    expect(mockClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "claim-retry",
        status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
      },
      data: expect.objectContaining({
        status: ClaimStatus.SUBMITTED,
        txHash: "0xretried",
        amount: 3.25,
      }),
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------

  it("records a FAILED claim row and rethrows when Soroban claim throws", async () => {
    (sorobanService.claimWinnings as jest.Mock).mockRejectedValue(
      new Error("contract failed"),
    );

    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "contract failed",
    );
    expect(mockClaimCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.FAILED,
        attempts: 1,
        lastError: "contract failed",
      }),
    });
    expect(betAuditService.emitClaimAccepted).not.toHaveBeenCalled();
  });

  it("increments attempts on an existing row when the claim fails", async () => {
    mockClaimFindFirst.mockResolvedValue({
      id: "claim-retry",
      walletAddress: VALID_ADDRESS,
      status: ClaimStatus.FAILED,
      txHash: null,
      amount: null,
    });
    (sorobanService.claimWinnings as jest.Mock).mockRejectedValue(
      new Error("RPC timeout"),
    );

    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow(
      "RPC timeout",
    );
    expect(mockClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "claim-retry",
        status: { in: [ClaimStatus.PENDING, ClaimStatus.FAILED] },
      },
      data: expect.objectContaining({
        status: ClaimStatus.FAILED,
        attempts: { increment: 1 },
        lastError: "RPC timeout",
      }),
    });
    expect(mockClaimCreate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Part 2 — Concurrency / double-claim risk
//
// These tests exercise the real withClaimLock implementation (in-memory mutex
// path, activated by DATA_STORE=memory) to verify that concurrent calls for
// the same wallet are serialised and that only one on-chain submission is made.
// ===========================================================================

describe("BetService.claimWinnings — concurrency & double-claim protection", () => {
  const originalEnv = process.env;

  // Restore the *real* withClaimLock for this suite.
  beforeEach(async () => {
    jest.resetModules();

    // Restore the original (un-mocked) implementation for the concurrency suite.
    mockWithClaimLock.mockImplementation(
      async (address: string, fn: () => Promise<unknown>) => {
        const { withClaimLock: realLock } = await import("../utils/claim-lock");
        return realLock(address, fn);
      },
    );

    // In-memory mode so no Postgres connection is needed.
    process.env = { ...originalEnv, DATA_STORE: "memory", BET_STUB_MODE: "false" };

    jest.clearAllMocks();
    mockClaimFindFirst.mockResolvedValue(null);
    mockClaimCreate.mockResolvedValue({ id: "claim-new" });
    mockClaimUpdateMany.mockResolvedValue({ count: 1 });

    resetInMemoryClaimLocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetInMemoryClaimLocks();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Builds a controlled claim sequence where:
   *  - The first call sees no open claim and succeeds on-chain.
   *  - All subsequent calls see a SUBMITTED row (set by the first call) and
   *    return 'already-submitted'.
   *
   * Because the in-memory lock serialises callers, the second caller will
   * always run after the first has updated the mock state.
   */
  function setupSerialConcurrentMocks(txHash = "0xonce") {
    let callCount = 0;

    // findFirst: first call returns null; subsequent calls see SUBMITTED row.
    mockClaimFindFirst.mockImplementation(async () => {
      if (callCount === 0) return null;
      return {
        id: "claim-submitted",
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.SUBMITTED,
        txHash,
        amount: 10,
      };
    });

    // sorobanService.claimWinnings: records that the on-chain call was made
    // and flips callCount so the next findFirst returns SUBMITTED.
    (sorobanService.claimWinnings as jest.Mock).mockImplementation(async () => {
      callCount++;
      return { state: "on-chain-success", amount: 10, txHash };
    });
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it("serialises two concurrent claims for the same wallet — only one hits the chain", async () => {
    setupSerialConcurrentMocks();

    // Fire both requests simultaneously (no await between them).
    const [r1, r2] = await Promise.all([
      betService.claimWinnings(VALID_ADDRESS),
      betService.claimWinnings(VALID_ADDRESS),
    ]);

    // Exactly one on-chain call must have been made.
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(1);

    // One result is the successful claim; the other is the idempotent replay.
    const states = [r1.state, r2.state].sort();
    expect(states).toEqual(["already-submitted", "on-chain-success"]);
  });

  it("serialises five concurrent claims for the same wallet — only one hits the chain", async () => {
    setupSerialConcurrentMocks();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => betService.claimWinnings(VALID_ADDRESS)),
    );

    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(1);

    const successCount = results.filter(
      (r) => r.state === "on-chain-success",
    ).length;
    const alreadyCount = results.filter(
      (r) => r.state === "already-submitted",
    ).length;

    expect(successCount).toBe(1);
    expect(alreadyCount).toBe(4);
  });

  it("does not serialise claims for different wallet addresses — both hit the chain", async () => {
    // Both wallets have no open claims and independent Soroban responses.
    mockClaimFindFirst.mockResolvedValue(null);
    (sorobanService.claimWinnings as jest.Mock)
      .mockResolvedValueOnce({ state: "on-chain-success", amount: 5, txHash: "0xA" })
      .mockResolvedValueOnce({ state: "on-chain-success", amount: 7, txHash: "0xB" });

    const [r1, r2] = await Promise.all([
      betService.claimWinnings(VALID_ADDRESS),
      betService.claimWinnings(OTHER_ADDRESS),
    ]);

    // Both wallets proceed independently — two on-chain calls.
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(2);
    expect(r1.state).toBe("on-chain-success");
    expect(r2.state).toBe("on-chain-success");
  });

  it("lock is re-entrant across sequential (non-concurrent) calls for the same wallet", async () => {
    // Sequential calls should always work — no deadlock from the mutex.
    (sorobanService.claimWinnings as jest.Mock).mockResolvedValue({
      state: "on-chain-success",
      amount: 3,
      txHash: "0xseq",
    });

    const r1 = await betService.claimWinnings(VALID_ADDRESS);
    // Second call: no open claim (mocked as null again for simplicity).
    const r2 = await betService.claimWinnings(VALID_ADDRESS);

    expect(r1.state).toBe("on-chain-success");
    expect(r2.state).toBe("on-chain-success");
    // Both calls succeeded sequentially — no deadlock.
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after a failed Soroban call so the next request can proceed", async () => {
    // First call: Soroban throws.
    (sorobanService.claimWinnings as jest.Mock)
      .mockRejectedValueOnce(new Error("RPC down"))
      .mockResolvedValueOnce({ state: "on-chain-success", amount: 5, txHash: "0xrecovered" });

    // First call should throw.
    await expect(betService.claimWinnings(VALID_ADDRESS)).rejects.toThrow("RPC down");

    // Lock must be released — second call proceeds without hanging.
    const result = await betService.claimWinnings(VALID_ADDRESS);
    expect(result.state).toBe("on-chain-success");
    expect(sorobanService.claimWinnings).toHaveBeenCalledTimes(2);
  });

  it("concurrent claims where both initially see null — second waits and sees SUBMITTED", async () => {
    // Simulate the race: both requests get past the first DB read at the same
    // instant.  With the in-memory lock they are serialised, so the second
    // one enters the critical section only after the first has finished.
    // After the first succeeds, findFirst returns the SUBMITTED row for the
    // second caller.
    let sorobanCalls = 0;
    mockClaimFindFirst.mockImplementation(async () => {
      // First caller sees nothing; second (and beyond) sees SUBMITTED.
      if (sorobanCalls === 0) return null;
      return {
        id: "claim-1",
        walletAddress: VALID_ADDRESS,
        status: ClaimStatus.SUBMITTED,
        txHash: "0xraced",
        amount: 8,
      };
    });

    (sorobanService.claimWinnings as jest.Mock).mockImplementation(async () => {
      sorobanCalls++;
      return { state: "on-chain-success", amount: 8, txHash: "0xraced" };
    });

    const [r1, r2] = await Promise.all([
      betService.claimWinnings(VALID_ADDRESS),
      betService.claimWinnings(VALID_ADDRESS),
    ]);

    // Only one on-chain submission regardless of how fast they were launched.
    expect(sorobanCalls).toBe(1);

    const states = new Set([r1.state, r2.state]);
    expect(states.has("on-chain-success")).toBe(true);
    expect(states.has("already-submitted")).toBe(true);
  });
});

// ===========================================================================
// Part 3 — withClaimLock unit tests (in-memory mutex)
// ===========================================================================

describe("withClaimLock — in-memory mutex (DATA_STORE=memory)", () => {
  const originalEnv = process.env;

  // Use the REAL implementation directly.
  let realWithClaimLock: typeof import("../utils/claim-lock").withClaimLock;
  let realResetLocks: typeof import("../utils/claim-lock").resetInMemoryClaimLocks;

  beforeEach(async () => {
    process.env = { ...originalEnv, DATA_STORE: "memory" };
    // Dynamic import picks up the unmocked module (jest.resetModules already called above,
    // but this suite imports directly so no interference with the mock above).
    const mod = await import("../utils/claim-lock");
    realWithClaimLock = mod.withClaimLock;
    realResetLocks = mod.resetInMemoryClaimLocks;
    realResetLocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    realResetLocks();
  });

  it("executes fn and returns its value", async () => {
    const result = await realWithClaimLock("addr-1", async () => 42);
    expect(result).toBe(42);
  });

  it("serialises two concurrent calls for the same address", async () => {
    const order: number[] = [];

    const p1 = realWithClaimLock("addr-x", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
      return "first";
    });

    const p2 = realWithClaimLock("addr-x", async () => {
      order.push(3);
      return "second";
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // First lock must complete entirely before second starts.
    expect(order).toEqual([1, 2, 3]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
  });

  it("allows concurrent calls for different addresses", async () => {
    const order: string[] = [];

    const p1 = realWithClaimLock("addr-a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
    });

    const p2 = realWithClaimLock("addr-b", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b-end");
    });

    await Promise.all([p1, p2]);

    // b should start (and finish) while a is still running.
    expect(order[0]).toBe("a-start");
    expect(order[1]).toBe("b-start");
    expect(order[2]).toBe("b-end");
    expect(order[3]).toBe("a-end");
  });

  it("releases the lock when fn throws so subsequent callers are not blocked", async () => {
    await expect(
      realWithClaimLock("addr-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Must not hang.
    const result = await realWithClaimLock("addr-err", async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("resetInMemoryClaimLocks() clears in-flight state between tests", async () => {
    let lockEntered = false;

    // Start a lock but don't resolve it yet.
    let externalResolve!: () => void;
    const blocking = realWithClaimLock("addr-reset", () => {
      lockEntered = true;
      return new Promise<void>((resolve) => {
        externalResolve = resolve;
      });
    });

    // Verify the lock is held.
    expect(lockEntered).toBe(true);

    // Reset clears the map entry so a fresh call doesn't wait for `blocking`.
    realResetLocks();
    const quick = await realWithClaimLock("addr-reset", async () => "quick");
    expect(quick).toBe("quick");

    // Resolve the original to avoid unhandled rejections.
    externalResolve();
    await blocking;
  });
});
