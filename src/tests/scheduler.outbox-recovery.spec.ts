/**
 * Outbox poll runs stale-PROCESSING recovery first, and never lets a recovery
 * failure stop the poll itself (Issue #855).
 */
import schedulerService from "../services/scheduler.service";
import outboxService from "../services/outbox.service";
import logger from "../utils/logger";

jest.mock("../services/retention.service");
jest.mock("../services/resolution.service");
jest.mock("../services/oracle");
jest.mock("../services/websocket.service");
jest.mock("../services/notification.service");
jest.mock("../utils/distributed-lock", () =>
  require("./helpers/distributed-lock.mock").passThroughLockModule(),
);
jest.mock("../services/outbox.service", () => ({
  __esModule: true,
  getOutboxPollIntervalSeconds: () => 10,
  default: {
    recoverStaleProcessing: jest.fn(),
    processOutbox: jest.fn(),
    cleanupProcessed: jest.fn(),
  },
}));
jest.mock("../lib/prisma", () => ({ prisma: { round: { findMany: jest.fn() } } }));
jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const recover = outboxService.recoverStaleProcessing as jest.Mock;
const process_ = outboxService.processOutbox as jest.Mock;

describe("SchedulerService.pollOutbox — stale PROCESSING recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process_.mockResolvedValue({ processed: 0, failed: 0, escalated: 0 });
  });

  it("recovers stale rows before processing the outbox", async () => {
    const order: string[] = [];
    recover.mockImplementation(async () => {
      order.push("recover");
      return { recovered: 2, failed: 0 };
    });
    process_.mockImplementation(async () => {
      order.push("process");
      return { processed: 0, failed: 0, escalated: 0 };
    });

    await schedulerService.pollOutbox();

    expect(order).toEqual(["recover", "process"]);
    expect(logger.info).toHaveBeenCalledWith(
      "Outbox stale-row recovery completed",
      { recovered: 2, failed: 0 },
    );
  });

  it("stays quiet when nothing was stale", async () => {
    recover.mockResolvedValue({ recovered: 0, failed: 0 });

    await schedulerService.pollOutbox();

    expect(logger.info).not.toHaveBeenCalledWith(
      "Outbox stale-row recovery completed",
      expect.anything(),
    );
    expect(process_).toHaveBeenCalledTimes(1);
  });

  it("still processes the outbox when recovery throws", async () => {
    recover.mockRejectedValue(new Error("db down"));

    await schedulerService.pollOutbox();

    expect(process_).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Outbox stale-row recovery failed; continuing with poll",
      { error: "db down" },
    );
  });
});
