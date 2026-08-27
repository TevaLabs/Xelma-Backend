import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { prisma } from "../lib/prisma";
import { betStore, InMemoryBetStore, PrismaBetStore } from "../data/bet-store";

/**
 * Restart-continuity tests for the bet store (Issue #519).
 *
 * Acceptance criteria:
 *   1. Bets survive a process restart in DB (postgres) mode.
 *   2. Mock (memory) mode still works and stays process-local.
 *   3. Tests cover both.
 *
 * "Restart" is simulated by constructing a fresh store instance against the
 * same database — exactly what happens when the process boots again.
 */
describe("Bet store persistence (#519)", () => {
  const ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
  const OTHER_ADDRESS = "GZZZZZZ1234567890ABCDEF1234567890ABCDEF1234567890";

  beforeAll(async () => {
    await prisma.betRecord.deleteMany({});
  });

  afterAll(async () => {
    await prisma.betRecord.deleteMany({});
  });

  describe("postgres mode (DATA_STORE=postgres)", () => {
    it("persists bets so a fresh store instance sees them (simulated restart)", async () => {
      // First "process": write bets through a brand-new Prisma backend.
      const firstProcess = new PrismaBetStore();
      const upBet = await firstProcess.addUpDownBet(
        "btc-updown-live",
        ADDRESS,
        10,
        "UP",
        "STUB",
      );
      const precisionBet = await firstProcess.addPrecisionBet(
        "eth-precision-live",
        ADDRESS,
        5,
        0.12,
        "SUBMITTED",
      );
      await firstProcess.markConfirmed(upBet.id, "0xabc123");

      // Second "process": a fresh store against the same database. The
      // in-memory Maps are empty, so anything returned must have come from
      // BetRecord — i.e. it survived the restart.
      const restarted = new PrismaBetStore();

      const reloadedUp = await restarted.getBet(upBet.id);
      expect(reloadedUp).toBeDefined();
      expect(reloadedUp!.status).toBe("CONFIRMED");
      expect(reloadedUp!.txHash).toBe("0xabc123");
      expect(reloadedUp!.confirmedAt).toEqual(expect.any(String));
      expect(reloadedUp!.address).toBe(ADDRESS);
      expect(reloadedUp!.amount).toBe(10);
      expect(reloadedUp!.side).toBe("UP");
      expect(reloadedUp!.mode).toBe("updown");
      expect(reloadedUp!.roundId).toBe("btc-updown-live");

      const reloadedPrecision = await restarted.getBet(precisionBet.id);
      expect(reloadedPrecision).toBeDefined();
      expect(reloadedPrecision!.status).toBe("SUBMITTED");
      expect(reloadedPrecision!.predictedPrice).toBe(0.12);
      expect(reloadedPrecision!.submittedAt).toEqual(expect.any(String));

      // Filters and summaries work against the persisted rows.
      expect(await restarted.getBets({ address: ADDRESS })).toHaveLength(2);
      expect(await restarted.getBets({ status: "CONFIRMED" })).toHaveLength(1);
      expect(await restarted.getBets({ status: "STUB" })).toHaveLength(0);
      expect((await restarted.getReconciliationSummary()).CONFIRMED).toBe(1);
      expect((await restarted.getReconciliationSummary()).SUBMITTED).toBe(1);
      expect(await restarted.getTotalBetsCount()).toBe(2);
    });

    it("resumes the bet sequence where the previous process stopped", async () => {
      await prisma.betRecord.deleteMany({});

      const firstProcess = new PrismaBetStore();
      const betA = await firstProcess.addUpDownBet("btc-updown-live", ADDRESS, 1, "UP");

      const restarted = new PrismaBetStore();
      const betB = await restarted.addUpDownBet("btc-updown-live", ADDRESS, 2, "DOWN");

      // The new process must not reuse the id the old process assigned.
      expect(betB.id).not.toBe(betA.id);
      // And the id shape is preserved for clients.
      expect(betB.id).toMatch(/^bet-\d+$/);
      expect(await restarted.getBet(betA.id)).toBeDefined();
      expect(await restarted.getBet(betB.id)).toBeDefined();
    });

    it("reconciles and fails persisted bets across the restart boundary", async () => {
      await prisma.betRecord.deleteMany({});

      const firstProcess = new PrismaBetStore();
      const stub = await firstProcess.addUpDownBet("btc-updown-live", OTHER_ADDRESS, 7, "UP", "STUB");
      const failed = await firstProcess.addUpDownBet("btc-updown-live", OTHER_ADDRESS, 9, "DOWN", "STUB");
      await firstProcess.markFailed(failed.id, "RPC unavailable");

      const restarted = new PrismaBetStore();
      // Stub → CONFIRMED after restart (the stub→live upgrade path).
      const reconciled = await restarted.markConfirmed(stub.id, "0xreconciled");
      expect(reconciled!.status).toBe("CONFIRMED");
      expect(reconciled!.txHash).toBe("0xreconciled");

      // Failure details survive the restart.
      const reloadedFailed = await restarted.getBet(failed.id);
      expect(reloadedFailed!.status).toBe("FAILED");
      expect(reloadedFailed!.failureReason).toBe("RPC unavailable");
      expect(reloadedFailed!.failedAt).toEqual(expect.any(String));
    });

    it("routes the shared betStore facade to the persisted backend", async () => {
      await prisma.betRecord.deleteMany({});
      const previousStore = process.env.DATA_STORE;

      try {
        process.env.DATA_STORE = "postgres";
        const bet = await betStore.addUpDownBet("btc-updown-live", ADDRESS, 4, "UP");

        const reloaded = await betStore.getBet(bet.id);
        expect(reloaded).toBeDefined();
        expect(reloaded!.id).toBe(bet.id);

        // A fresh backend constructed outside the facade sees the same row.
        const fresh = new PrismaBetStore();
        expect(await fresh.getBet(bet.id)).toBeDefined();
      } finally {
        if (previousStore === undefined) {
          delete process.env.DATA_STORE;
        } else {
          process.env.DATA_STORE = previousStore;
        }
      }
    });
  });

  describe("memory mode (DATA_STORE=memory)", () => {
    it("keeps bets process-local — a fresh store has no trace of them", async () => {
      // Clear rows left behind by the postgres-mode tests above so the
      // "never mixes stores" assertion below compares against an empty DB.
      await prisma.betRecord.deleteMany({});

      const previousStore = process.env.DATA_STORE;

      try {
        process.env.DATA_STORE = "memory";
        const bet = await betStore.addUpDownBet("btc-updown-live", ADDRESS, 3, "UP");

        // Same process, same facade: the bet is readable…
        expect(await betStore.getBet(bet.id)).toBeDefined();

        // …but a simulated restart (fresh in-memory store) loses it.
        const restarted = new InMemoryBetStore();
        await expect(restarted.getBet(bet.id)).resolves.toBeUndefined();
        expect(await restarted.getBets({ address: ADDRESS })).toHaveLength(0);

        // The facade itself switches back cleanly and never mixes stores.
        process.env.DATA_STORE = "postgres";
        await expect(betStore.getBet(bet.id)).resolves.toBeUndefined();
      } finally {
        if (previousStore === undefined) {
          delete process.env.DATA_STORE;
        } else {
          process.env.DATA_STORE = previousStore;
        }
      }
    });

    it("still supports the full reconciliation lifecycle in memory mode", async () => {
      const previousStore = process.env.DATA_STORE;

      try {
        process.env.DATA_STORE = "memory";
        const bet = await betStore.addPrecisionBet(
          "eth-precision-live",
          ADDRESS,
          2.5,
          0.29,
          "SUBMITTED",
        );
        await betStore.markConfirmed(bet.id, "0xmem");

        const reloaded = await betStore.getBet(bet.id);
        expect(reloaded!.status).toBe("CONFIRMED");
        expect(reloaded!.txHash).toBe("0xmem");
        expect(reloaded!.amount).toBe(2.5);
        expect(reloaded!.predictedPrice).toBe(0.29);
      } finally {
        if (previousStore === undefined) {
          delete process.env.DATA_STORE;
        } else {
          process.env.DATA_STORE = previousStore;
        }
      }
    });
  });
});
