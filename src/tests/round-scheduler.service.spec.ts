// Mocks must be declared before any imports — ts-jest hoists these calls.

jest.mock("node-cron", () => ({
  schedule: jest.fn().mockReturnValue({ stop: jest.fn() }),
}));

jest.mock("../services/oracle", () => ({
  __esModule: true,
  default: {
    getPrice: jest.fn(),
    isStale: jest.fn(),
  },
}));

jest.mock("../services/round.service", () => ({
  __esModule: true,
  default: {
    startRound: jest.fn(),
    autoLockExpiredRounds: jest.fn(),
  },
}));

/**
 * Mock Prisma so these unit tests run without a real database.
 * `closeEligibleRounds` and `createRound` each only touch one method on
 * `prisma.round`, making a targeted mock straightforward.
 */
jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    $disconnect: jest.fn(),
  },
}));

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { prisma } from "../lib/prisma";
import roundSchedulerService from "../services/round-scheduler.service";
import roundService from "../services/round.service";
import priceOracle from "../services/oracle";
import cron from "node-cron";

// ─────────────────────────────────────────────────────────────────────────────

describe("RoundSchedulerService", () => {
  // ── start() ─────────────────────────────────────────────────────────────────

  describe("start()", () => {
    afterEach(() => {
      roundSchedulerService.stop();
      delete process.env.ROUND_SCHEDULER_ENABLED;
    });

    it("does not schedule tasks when ROUND_SCHEDULER_ENABLED is not set", () => {
      roundSchedulerService.start();

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    it('does not schedule tasks when ROUND_SCHEDULER_ENABLED is "false"', () => {
      process.env.ROUND_SCHEDULER_ENABLED = "false";

      roundSchedulerService.start();

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    it('schedules two tasks when ROUND_SCHEDULER_ENABLED is "true"', () => {
      process.env.ROUND_SCHEDULER_ENABLED = "true";

      roundSchedulerService.start();

      expect(cron.schedule).toHaveBeenCalledTimes(2);
    });

    it("schedules round creation on the 4-minute mark", () => {
      process.env.ROUND_SCHEDULER_ENABLED = "true";

      roundSchedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        "0 */4 * * * *",
        expect.any(Function),
      );
    });

    it("schedules the close-eligible-rounds check every 30 seconds", () => {
      process.env.ROUND_SCHEDULER_ENABLED = "true";

      roundSchedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        "*/30 * * * * *",
        expect.any(Function),
      );
    });
  });

  // ── getMode() ────────────────────────────────────────────────────────────────

  describe("getMode()", () => {
    afterEach(() => {
      delete process.env.ROUND_SCHEDULER_MODE;
    });

    it("defaults to UP_DOWN when ROUND_SCHEDULER_MODE is not set", () => {
      expect(roundSchedulerService.getMode()).toBe("UP_DOWN");
    });

    it("returns LEGENDS when ROUND_SCHEDULER_MODE is LEGENDS", () => {
      process.env.ROUND_SCHEDULER_MODE = "LEGENDS";

      expect(roundSchedulerService.getMode()).toBe("LEGENDS");
    });

    it("falls back to UP_DOWN for any unrecognised value", () => {
      process.env.ROUND_SCHEDULER_MODE = "INVALID";

      expect(roundSchedulerService.getMode()).toBe("UP_DOWN");
    });
  });

  // ── createRound() ────────────────────────────────────────────────────────────
  //
  // Decision logic under test:
  //   oracle null/zero/negative → skip
  //   oracle stale              → skip
  //   DB has active round       → skip
  //   clean state               → delegate to roundService.startRound
  //   startRound throws ACTIVE_ROUND_EXISTS → info log, no rethrow
  //   startRound throws unknown error       → error log, no rethrow

  describe("createRound()", () => {
    beforeEach(() => {
      delete process.env.ROUND_SCHEDULER_MODE;

      // Healthy oracle defaults — individual tests override as needed.
      (priceOracle.getPrice as any).mockReturnValue(0.35);
      (priceOracle.isStale as any).mockReturnValue(false);

      // DB: no active round by default.
      (prisma.round.findFirst as any).mockResolvedValue(null);

      (roundService.startRound as any).mockResolvedValue({ id: "mock-round" });
    });

    afterEach(() => {
      delete process.env.ROUND_SCHEDULER_MODE;
    });

    it("calls startRound with oracle price and 1-minute duration when all gates pass", async () => {
      await roundSchedulerService.createRound();

      expect(roundService.startRound).toHaveBeenCalledTimes(1);
      expect(roundService.startRound).toHaveBeenCalledWith("UP_DOWN", 0.35, 1);
    });

    it("skips creation when oracle price is null", async () => {
      (priceOracle.getPrice as any).mockReturnValue(null);

      await roundSchedulerService.createRound();

      expect(prisma.round.findFirst).not.toHaveBeenCalled();
      expect(roundService.startRound).not.toHaveBeenCalled();
    });

    it("skips creation when oracle price is zero", async () => {
      (priceOracle.getPrice as any).mockReturnValue(0);

      await roundSchedulerService.createRound();

      expect(roundService.startRound).not.toHaveBeenCalled();
    });

    it("skips creation when oracle price is negative", async () => {
      (priceOracle.getPrice as any).mockReturnValue(-0.5);

      await roundSchedulerService.createRound();

      expect(roundService.startRound).not.toHaveBeenCalled();
    });

    it("skips creation when oracle data is stale", async () => {
      (priceOracle.isStale as any).mockReturnValue(true);

      await roundSchedulerService.createRound();

      expect(prisma.round.findFirst).not.toHaveBeenCalled();
      expect(roundService.startRound).not.toHaveBeenCalled();
    });

    it("skips creation when an active round for the same mode already exists", async () => {
      (prisma.round.findFirst as any).mockResolvedValue({
        id: "existing-round-id",
        mode: "UP_DOWN",
        status: "ACTIVE",
      });

      await roundSchedulerService.createRound();

      expect(roundService.startRound).not.toHaveBeenCalled();
    });

    it("queries the DB with the correct mode filter", async () => {
      await roundSchedulerService.createRound();

      expect(prisma.round.findFirst).toHaveBeenCalledWith({
        where: { mode: "UP_DOWN", status: "ACTIVE" },
      });
    });

    it("does not throw when startRound raises ACTIVE_ROUND_EXISTS", async () => {
      const err: any = new Error("An active UP_DOWN round already exists");
      err.code = "ACTIVE_ROUND_EXISTS";
      (roundService.startRound as any).mockRejectedValue(err);

      await expect(roundSchedulerService.createRound()).resolves.not.toThrow();
    });

    it("does not throw when startRound raises an unexpected error", async () => {
      (roundService.startRound as any).mockRejectedValue(
        new Error("Network timeout"),
      );

      await expect(roundSchedulerService.createRound()).resolves.not.toThrow();
    });

    it("passes LEGENDS mode to startRound when ROUND_SCHEDULER_MODE is LEGENDS", async () => {
      process.env.ROUND_SCHEDULER_MODE = "LEGENDS";

      await roundSchedulerService.createRound();

      expect(roundService.startRound).toHaveBeenCalledWith("LEGENDS", 0.35, 1);
    });

    it("queries the DB with LEGENDS mode when env is LEGENDS", async () => {
      process.env.ROUND_SCHEDULER_MODE = "LEGENDS";

      await roundSchedulerService.createRound();

      expect(prisma.round.findFirst).toHaveBeenCalledWith({
        where: { mode: "LEGENDS", status: "ACTIVE" },
      });
    });
  });

  // ── closeEligibleRounds() ────────────────────────────────────────────────────
  //
  // Decision logic under test:
  //   count = 0             → autoLockExpiredRounds not called
  //   count > 0             → autoLockExpiredRounds called once
  //   autoLock throws       → graceful error log, no rethrow
  //
  // The service calls `new Date()` before passing it to the DB query, but
  // since prisma is mocked the actual timestamp has no effect on outcomes.
  // Fake timers are therefore not needed here.

  describe("closeEligibleRounds()", () => {
    beforeEach(() => {
      (roundService.autoLockExpiredRounds as any).mockResolvedValue(undefined);
      // Default: no expired rounds.
      (prisma.round.count as any).mockResolvedValue(0);
    });

    it("does not call autoLockExpiredRounds when the expired-round count is zero", async () => {
      (prisma.round.count as any).mockResolvedValue(0);

      await roundSchedulerService.closeEligibleRounds();

      expect(roundService.autoLockExpiredRounds).not.toHaveBeenCalled();
    });

    it("calls autoLockExpiredRounds once when expired ACTIVE rounds exist", async () => {
      (prisma.round.count as any).mockResolvedValue(3);

      await roundSchedulerService.closeEligibleRounds();

      expect(roundService.autoLockExpiredRounds).toHaveBeenCalledTimes(1);
    });

    it("queries the DB filtering only ACTIVE status with lte endTime", async () => {
      (prisma.round.count as any).mockResolvedValue(1);

      await roundSchedulerService.closeEligibleRounds();

      expect(prisma.round.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "ACTIVE",
            endTime: expect.objectContaining({ lte: expect.any(Date) }),
          }),
        }),
      );
    });

    it("does not throw when autoLockExpiredRounds fails", async () => {
      (prisma.round.count as any).mockResolvedValue(2);
      (roundService.autoLockExpiredRounds as any).mockRejectedValue(
        new Error("DB connection lost"),
      );

      await expect(
        roundSchedulerService.closeEligibleRounds(),
      ).resolves.not.toThrow();
    });

    it("does not call autoLock when count is exactly zero", async () => {
      (prisma.round.count as any).mockResolvedValue(0);

      await roundSchedulerService.closeEligibleRounds();

      expect(roundService.autoLockExpiredRounds).not.toHaveBeenCalled();
    });

    it("calls autoLock when count is exactly one", async () => {
      (prisma.round.count as any).mockResolvedValue(1);

      await roundSchedulerService.closeEligibleRounds();

      expect(roundService.autoLockExpiredRounds).toHaveBeenCalledTimes(1);
    });
  });
});
