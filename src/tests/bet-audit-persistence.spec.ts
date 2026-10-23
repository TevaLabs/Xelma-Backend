/**
 * Integration tests — BetAuditEvent persistence (Issue #835).
 *
 * Unlike bet-audit.spec.ts (unit, mocked Prisma), this suite runs the real
 * BetAuditService against a real PostgreSQL database to prove the issue's
 * premise: with BET_AUDIT_STORAGE=database, audit history survives a
 * restart of the in-memory store; with the default (memory) the table is
 * never touched.
 *
 * Requires a migrated database (CI runs `npm run db:migrate` first).
 * Skipped automatically when no real DATABASE_URL is configured — same
 * `shouldRunDbTests` gate as the other DB-backed integration suites.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "@jest/globals";
import { betAuditService } from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";

const shouldRunDbTests =
  process.env.RUN_DB_TESTS === "true" ||
  process.env.CI === "true" ||
  (global as any).hasDb;

const describeBetAuditDb = shouldRunDbTests ? describe : describe.skip;

const VALID_ADDRESS =
  "GINTEGRATION835AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Poll until `check` returns a truthy value or the deadline passes. */
async function waitFor<T>(
  check: () => Promise<T>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describeBetAuditDb("BetAuditEvent persistence (Issue #835)", () => {
  let originalStorage: string | undefined;

  beforeAll(() => {
    originalStorage = process.env.BET_AUDIT_STORAGE;
  });

  beforeEach(async () => {
    betAuditService.clear();
    await prisma.betAuditEvent.deleteMany({ where: { address: VALID_ADDRESS } });
  });

  afterEach(() => {
    betAuditService.clear();
    if (originalStorage !== undefined) {
      process.env.BET_AUDIT_STORAGE = originalStorage;
    } else {
      delete process.env.BET_AUDIT_STORAGE;
    }
  });

  afterAll(async () => {
    await prisma.betAuditEvent.deleteMany({ where: { address: VALID_ADDRESS } });
    await prisma.$disconnect();
  });

  it("persists events to the BetAuditEvent table in database mode", async () => {
    process.env.BET_AUDIT_STORAGE = "database";

    betAuditService.emitBetAccepted({
      address: VALID_ADDRESS,
      amount: 42.5,
      side: "UP",
      mode: "UP_DOWN",
      result: "stub",
      status: "ACCEPTED",
    });

    const row = await waitFor(() =>
      prisma.betAuditEvent.findFirst({ where: { address: VALID_ADDRESS } }),
    );

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      event: "BET_ACCEPTED",
      address: VALID_ADDRESS,
      side: "UP",
      mode: "UP_DOWN",
      result: "stub",
      status: "ACCEPTED",
    });
    expect(Number(row!.amount)).toBe(42.5);
  });

  it("keeps audit history queryable after the in-memory store resets", async () => {
    process.env.BET_AUDIT_STORAGE = "database";

    betAuditService.emitBetFailed({
      address: VALID_ADDRESS,
      amount: 10,
      side: "DOWN",
      mode: "UP_DOWN",
      result: "on-chain-failure",
      failureReason: "tx rejected",
    });

    const persisted = await waitFor(async () => {
      const count = await prisma.betAuditEvent.count({
        where: { address: VALID_ADDRESS },
      });
      return count > 0 ? count : null;
    });
    expect(persisted).toBeGreaterThan(0);

    // Simulate a process restart: the in-memory ring is gone, the rows are not.
    betAuditService.clear();
    expect(betAuditService.getEvents()).toHaveLength(0);

    const rows = await prisma.betAuditEvent.findMany({
      where: { address: VALID_ADDRESS },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      event: "BET_FAILED",
      failureReason: "tx rejected",
    });
  });

  it("never touches the table in memory mode (default)", async () => {
    delete process.env.BET_AUDIT_STORAGE;
    expect(betAuditService.storageMode).toBe("memory");

    betAuditService.emitBetAccepted({
      address: VALID_ADDRESS,
      amount: 100,
      side: "UP",
      mode: "UP_DOWN",
      result: "stub",
    });

    // Long enough for a (wrongly triggered) fire-and-forget write to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const count = await prisma.betAuditEvent.count({
      where: { address: VALID_ADDRESS },
    });
    expect(count).toBe(0);
    expect(betAuditService.getEvents()).toHaveLength(1);
  });
});
