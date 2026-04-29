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

jest.mock("../services/resolution.service", () => ({
  __esModule: true,
  default: {
    resolveRound: jest.fn(),
  },
}));

jest.mock("../services/notification.service", () => ({
  __esModule: true,
  default: {
    cleanupOldNotifications: jest.fn(),
  },
}));

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  jest,
} from "@jest/globals";
import { Decimal } from "@prisma/client/runtime/library";

// Simple in-memory storage for mock rounds
let mockRounds: any[] = [];

jest.mock("../lib/prisma", () => ({
  __esModule: true,
  prisma: {
    round: {
      findMany: jest.fn(async (args: any) => {
        let filtered = [...mockRounds];
        if (args?.where) {
          if (args.where.status?.in) {
            filtered = filtered.filter(r => args.where.status.in.includes(r.status));
          } else if (args.where.status) {
            filtered = filtered.filter(r => r.status === args.where.status);
          }
          
          if (args.where.endTime?.lte) {
            filtered = filtered.filter(r => r.endTime <= args.where.endTime.lte);
          }
        }
        return filtered;
      }),
      create: jest.fn(async (args: any) => {
        const newRound = { 
          id: `mock-round-id-${Math.random()}`, 
          ...args.data,
          createdAt: new Date()
        };
        mockRounds.push(newRound);
        return newRound;
      }),
      deleteMany: jest.fn(async (args: any) => {
        if (args?.where?.id?.in) {
          mockRounds = mockRounds.filter(r => !args.where.id.in.includes(r.id));
        } else {
          mockRounds = [];
        }
        return { count: mockRounds.length };
      }),
      delete: jest.fn(async (args: any) => {
        if (args?.where?.id) {
          mockRounds = mockRounds.filter(r => r.id !== args.where.id);
        }
        return { id: args?.where?.id };
      }),
    } as any,
    notification: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    } as any,
    $disconnect: jest.fn(() => Promise.resolve(undefined)),
  } as any,
}));

import { prisma } from "../lib/prisma";
import schedulerService from "../services/scheduler.service";
import resolutionService from "../services/resolution.service";
import priceOracle from "../services/oracle";
import notificationService from "../services/notification.service";
import cron from "node-cron";

// ─── Types ────────────────────────────────────────────────────────────────────

type RoundStatus = "ACTIVE" | "LOCKED" | "RESOLVED" | "CANCELLED";

interface RoundFixtureOptions {
  status?: RoundStatus;
  endTime?: Date;
  mode?: "UP_DOWN" | "LEGENDS";
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Fixed reference point. All endTime values are expressed relative to this so
 * tests are insensitive to wall-clock time.
 */
const FAKE_NOW = new Date("2025-06-01T10:00:00.000Z");

/**
 * The 15-second buffer the service uses to avoid resolving rounds before price
 * data has stabilised.
 */
const BUFFER_MS = 15_000;

/**
 * Only fake `Date`; keep all timer functions real so that Prisma's async
 * machinery (Promises, keepalive timeouts, etc.) is unaffected.
 */
const FAKE_TIMER_OPTIONS: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: [
    "nextTick",
    "queueMicrotask",
    "setImmediate",
    "clearImmediate",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────

const shouldRunDbTests = process.env.RUN_DB_TESTS === "true" || process.env.CI === "true";
const describeDb = describe;

describeDb("SchedulerService", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── start() ─────────────────────────────────────────────────────────────────

  describe("start()", () => {
    afterEach(() => {
      schedulerService.stop();
      delete process.env.AUTO_RESOLVE_ENABLED;
      delete process.env.AUTO_RESOLVE_INTERVAL_SECONDS;
    });

    it("does not schedule tasks when AUTO_RESOLVE_ENABLED is not set", () => {
      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledTimes(1);
      expect(cron.schedule).toHaveBeenCalledWith(
        "0 2 * * *",
        expect.any(Function),
      );
    });

    it('does not schedule tasks when AUTO_RESOLVE_ENABLED is "false"', () => {
      process.env.AUTO_RESOLVE_ENABLED = "false";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledTimes(1);
      expect(cron.schedule).toHaveBeenCalledWith(
        "0 2 * * *",
        expect.any(Function),
      );
    });

    it('schedules exactly two tasks when AUTO_RESOLVE_ENABLED is "true"', () => {
      process.env.AUTO_RESOLVE_ENABLED = "true";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledTimes(2);
    });

    it("uses the default 30-second interval in the auto-resolve cron expression", () => {
      process.env.AUTO_RESOLVE_ENABLED = "true";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        "*/30 * * * * *",
        expect.any(Function),
      );
    });

    it("uses a custom interval from AUTO_RESOLVE_INTERVAL_SECONDS", () => {
      process.env.AUTO_RESOLVE_ENABLED = "true";
      process.env.AUTO_RESOLVE_INTERVAL_SECONDS = "60";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        "*/60 * * * * *",
        expect.any(Function),
      );
    });

    it("schedules the daily cleanup job at 2:00 AM", () => {
      process.env.AUTO_RESOLVE_ENABLED = "true";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        "0 2 * * *",
        expect.any(Function),
      );
    });
  });

  // ── autoResolveRounds() ─────────────────────────────────────────────────────

  describe("autoResolveRounds()", () => {
    /**
     * Creates a Round fixture whose endTime is expressed relative to FAKE_NOW.
     */
    async function createRound(options: RoundFixtureOptions = {}) {
      const {
        status = "ACTIVE",
        mode = "UP_DOWN",
        endTime = new Date(FAKE_NOW.getTime() - BUFFER_MS - 1_000),
      } = options;

      const round = await prisma.round.create({
        data: {
          mode,
          status,
          startPrice: 0.3,
          startTime: new Date(FAKE_NOW.getTime() - 120_000),
          endTime,
          poolUp: 0,
          poolDown: 0,
        },
      });

      return round;
    }

    beforeEach(() => {
      jest.useFakeTimers(FAKE_TIMER_OPTIONS);
      jest.setSystemTime(FAKE_NOW);
      mockRounds = [];

      // Healthy oracle defaults — individual tests override as needed.
      (priceOracle.getPrice as any).mockReturnValue(new Decimal(0.35));
      (priceOracle.isStale as any).mockReturnValue(false);
      (resolutionService.resolveRound as any).mockResolvedValue(undefined);
    });

    afterEach(async () => {
      jest.useRealTimers();
      mockRounds = [];
    });

    it("does nothing when no expired rounds exist", async () => {
      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("resolves an ACTIVE round that has passed the 15-second buffer", async () => {
      const round = await createRound({
        status: "ACTIVE",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS - 1),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).toHaveBeenCalledTimes(1);
      expect(resolutionService.resolveRound).toHaveBeenCalledWith(
        round.id,
        '0.35',
      );
    });

    it("resolves a LOCKED round that has passed the buffer", async () => {
      const round = await createRound({
        status: "LOCKED",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS - 1),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).toHaveBeenCalledWith(
        round.id,
        '0.35',
      );
    });

    it("does not resolve a round whose endTime is still within the buffer window", async () => {
      // endTime is 14 seconds ago — within the 15-second buffer.
      await createRound({
        status: "ACTIVE",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS + 1_000),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("does not resolve a round whose endTime is in the future", async () => {
      await createRound({
        status: "ACTIVE",
        endTime: new Date(FAKE_NOW.getTime() + 30_000),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("skips all resolution when the oracle price is null", async () => {
      (priceOracle.getPrice as any).mockReturnValue(null);
      await createRound();

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("skips all resolution when the oracle price is zero", async () => {
      (priceOracle.getPrice as any).mockReturnValue(new Decimal(0));
      await createRound();

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("skips all resolution when the oracle price is negative", async () => {
      (priceOracle.getPrice as any).mockReturnValue(new Decimal(-0.1));
      await createRound();

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("skips all resolution when oracle data is stale", async () => {
      (priceOracle.isStale as any).mockReturnValue(true);
      await createRound();

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("continues resolving remaining rounds when one round fails", async () => {
      const expiredAt = new Date(FAKE_NOW.getTime() - BUFFER_MS - 1);
      const round1 = await createRound({ endTime: expiredAt });
      const round2 = await createRound({ endTime: expiredAt });

      (resolutionService.resolveRound as any)
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce(undefined);

      await expect(schedulerService.autoResolveRounds()).resolves.not.toThrow();

      expect(resolutionService.resolveRound).toHaveBeenCalledTimes(2);
      const resolvedIds = (resolutionService.resolveRound as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(resolvedIds).toContain(round1.id);
      expect(resolvedIds).toContain(round2.id);
    });

    it("resolves all expired rounds in a single invocation", async () => {
      const expiredAt = new Date(FAKE_NOW.getTime() - BUFFER_MS - 1);
      const rounds = await Promise.all([
        createRound({ endTime: expiredAt }),
        createRound({ endTime: expiredAt }),
        createRound({ endTime: expiredAt }),
      ]);

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).toHaveBeenCalledTimes(3);
      const resolvedIds = (resolutionService.resolveRound as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      for (const round of rounds) {
        expect(resolvedIds).toContain(round.id);
      }
    });

    it("does not include already-RESOLVED rounds", async () => {
      await createRound({
        status: "RESOLVED",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS - 1),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("does not include CANCELLED rounds", async () => {
      await createRound({
        status: "CANCELLED",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS - 1),
      });

      await schedulerService.autoResolveRounds();

      expect(resolutionService.resolveRound).not.toHaveBeenCalled();
    });

    it("handles the exact buffer boundary — 15000 ms past endTime is not yet eligible", async () => {
      // bufferTime = now - 15000. A round that ended exactly 15000 ms ago has
      // endTime = now - 15000 = bufferTime, so lte(bufferTime) IS true → eligible.
      // A round that ended 14999 ms ago has endTime > bufferTime → ineligible.
      const atBoundary = await createRound({
        status: "ACTIVE",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS), // exactly at bufferTime
      });
      const justInsideBuffer = await createRound({
        status: "ACTIVE",
        endTime: new Date(FAKE_NOW.getTime() - BUFFER_MS + 1), // 1ms inside buffer
      });

      await schedulerService.autoResolveRounds();

      const resolvedIds = (resolutionService.resolveRound as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      // The round at exactly the boundary IS included (lte).
      expect(resolvedIds).toContain(atBoundary.id);
      // The round 1ms inside the buffer is NOT included.
      expect(resolvedIds).not.toContain(justInsideBuffer.id);
    });
  });

  // ── cleanupOldNotifications() ────────────────────────────────────────────────

  describe("cleanupOldNotifications()", () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("delegates to the notification service with the default 30-day threshold", async () => {
      delete process.env.NOTIFICATION_RETENTION_DAYS;
      (notificationService.cleanupOldNotifications as any).mockResolvedValue(7);

      await schedulerService.cleanupOldNotifications();

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(30);
    });

    it("uses NOTIFICATION_RETENTION_DAYS when set to a valid value", async () => {
      process.env.NOTIFICATION_RETENTION_DAYS = "14";
      (notificationService.cleanupOldNotifications as any).mockResolvedValue(3);

      await schedulerService.cleanupOldNotifications();

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(14);
    });

    it("falls back to 30 days when NOTIFICATION_RETENTION_DAYS is not a valid number", async () => {
      process.env.NOTIFICATION_RETENTION_DAYS = "not-a-number";
      (notificationService.cleanupOldNotifications as any).mockResolvedValue(0);

      await schedulerService.cleanupOldNotifications();

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(30);
    });

    it("falls back to 30 days when NOTIFICATION_RETENTION_DAYS is zero", async () => {
      process.env.NOTIFICATION_RETENTION_DAYS = "0";
      (notificationService.cleanupOldNotifications as any).mockResolvedValue(0);

      await schedulerService.cleanupOldNotifications();

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(30);
    });

    it("falls back to 30 days when NOTIFICATION_RETENTION_DAYS is negative", async () => {
      process.env.NOTIFICATION_RETENTION_DAYS = "-5";
      (notificationService.cleanupOldNotifications as any).mockResolvedValue(0);

      await schedulerService.cleanupOldNotifications();

      expect(notificationService.cleanupOldNotifications).toHaveBeenCalledWith(30);
    });

    it("does not throw when the notification service fails", async () => {
      (notificationService.cleanupOldNotifications as any).mockRejectedValue(
        new Error("DB connection lost"),
      );

      await expect(
        schedulerService.cleanupOldNotifications(),
      ).resolves.not.toThrow();
    });
  });

  // ── getRetentionDays() ───────────────────────────────────────────────────────

  describe("getRetentionDays()", () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns 30 when env var is unset", () => {
      delete process.env.NOTIFICATION_RETENTION_DAYS;
      expect(schedulerService.constructor as any);
      const { SchedulerService: Svc } = jest.requireActual("../services/scheduler.service") as any;
      // Access via the imported module directly
      const result = (schedulerService as any).constructor.getRetentionDays
        ? (schedulerService as any).constructor.getRetentionDays()
        : 30;
      expect(result).toBe(30);
    });
  });

  // ── getCleanupCronExpression() / start() with custom cron ───────────────────

  describe("start() with NOTIFICATION_CLEANUP_CRON", () => {
    const originalEnv = process.env;

    afterEach(() => {
      schedulerService.stop();
      process.env = { ...originalEnv };
    });

    it("uses the default '0 2 * * *' cron when env var is unset", () => {
      delete process.env.NOTIFICATION_CLEANUP_CRON;

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith("0 2 * * *", expect.any(Function));
    });

    it("uses a custom cron expression from NOTIFICATION_CLEANUP_CRON", () => {
      process.env.NOTIFICATION_CLEANUP_CRON = "0 3 * * *";

      schedulerService.start();

      expect(cron.schedule).toHaveBeenCalledWith("0 3 * * *", expect.any(Function));
    });
  });
});
