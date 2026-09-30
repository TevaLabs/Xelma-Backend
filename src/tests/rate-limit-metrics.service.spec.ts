import { beforeEach, describe, expect, it } from "@jest/globals";
import { RateLimitMetricsService } from "../services/rate-limit-metrics.service";
import { MemoryRateLimitMetricsBackend } from "../services/rate-limit-metrics.backends";

const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockGroupBy = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    rateLimitMetric: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      groupBy: (...args: unknown[]) => mockGroupBy(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));

describe("RateLimitMetricsService (Prisma backend)", () => {
  let service: RateLimitMetricsService;

  beforeEach(() => {
    service = new RateLimitMetricsService();
    jest.clearAllMocks();
  });

  it("uses the Prisma backend by default in full mode", () => {
    expect(service.backendKind).toBe("prisma");
  });

  it("groups monitored categories and flags repeat offenders", async () => {
    const now = new Date();
    mockFindMany.mockResolvedValue(
      Array.from({ length: 5 }, () => ({
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      })).concat([
        {
          endpoint: "chat/message",
          key: "user-1",
          userId: "user-1",
          ip: "127.0.0.1",
          timestamp: now,
        },
        {
          endpoint: "prediction/batch-submit",
          key: "user-2",
          userId: "user-2",
          ip: "127.0.0.1",
          timestamp: now,
        },
      ]),
    );

    const result = await service.getSuspiciousActivity(5);

    expect(result.byCategory).toHaveLength(3);
    const authCategory = result.byCategory.find((c) => c.category === "auth");
    expect(authCategory?.hits).toBe(5);
    expect(authCategory?.uniqueKeys).toBe(1);

    expect(result.flaggedActors).toHaveLength(1);
    expect(result.flaggedActors[0]).toMatchObject({
      endpoint: "auth/connect",
      key: "ip-1",
      hits: 5,
      category: "auth",
    });
  });

  it("writes each increment to Prisma exactly once (no double counting)", async () => {
    mockCreate.mockResolvedValue({});
    mockGroupBy.mockResolvedValue([{ endpoint: "auth/connect", _count: { id: 1 } }]);
    mockFindMany.mockResolvedValue([
      {
        endpoint: "auth/connect",
        key: "ip-1",
        ip: "1.2.3.4",
        userId: null,
        timestamp: new Date(),
      },
    ]);

    await service.recordHit({ endpoint: "auth/connect", key: "ip-1", ip: "1.2.3.4" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        endpoint: "auth/connect",
        key: "ip-1",
        ip: "1.2.3.4",
      }),
    });

    const summary = await service.getSummary(10);
    // Summaries come solely from the mocked Prisma rows — the record is not
    // duplicated by a shadow in-memory copy.
    expect(summary.backend).toBe("prisma");
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0].endpoint).toBe("auth/connect");
    expect(summary.topEndpoints).toEqual([{ endpoint: "auth/connect", hits: 1 }]);
  });

  it("clears old metrics through Prisma and returns the deleted count", async () => {
    mockDeleteMany.mockResolvedValue({ count: 3 });

    const deleted = await service.clearOldMetrics(7);

    expect(deleted).toBe(3);
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("RateLimitMetricsService fallback to memory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("degrades to the in-memory backend when a Prisma write fails", async () => {
    mockCreate.mockRejectedValue(new Error("relation does not exist"));
    const service = new RateLimitMetricsService();

    await service.recordHit({ endpoint: "auth/connect", key: "ip-1", ip: "1.2.3.4" });

    expect(service.backendKind).toBe("memory");

    const summary = await service.getSummary(10);
    expect(summary.backend).toBe("memory");
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0].endpoint).toBe("auth/connect");
  });

  it("flags suspicious actors from degraded in-memory records", async () => {
    mockCreate.mockRejectedValue(new Error("connection refused"));
    const service = new RateLimitMetricsService();

    for (let i = 0; i < 6; i++) {
      await service.recordHit({ endpoint: "auth/connect", key: "bad-actor", ip: "1.2.3.4" });
    }

    const result = await service.getSuspiciousActivity(10);
    expect(result.flaggedActors.length).toBeGreaterThanOrEqual(1);
    expect(result.flaggedActors[0].key).toBe("bad-actor");
    expect(result.flaggedActors[0].hits).toBe(6);
    expect(result.flaggedActors[0].category).toBe("auth");
  });

  it("degrades to memory when a Prisma read fails", async () => {
    mockGroupBy.mockRejectedValue(new Error("connection refused"));
    mockFindMany.mockRejectedValue(new Error("connection refused"));
    const service = new RateLimitMetricsService();

    const summary = await service.getSummary(10);

    expect(service.backendKind).toBe("memory");
    expect(summary.backend).toBe("memory");
    expect(summary.topEndpoints).toEqual([]);
  });

  it("clears old records from the in-memory backend", async () => {
    const service = new RateLimitMetricsService(new MemoryRateLimitMetricsBackend());
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);

    await service.increment("test/route", 429, { key: "k", timestamp: oldDate });
    await service.increment("test/route", 429, { key: "k" });

    expect(await service.clearOldMetrics(7)).toBe(1);
    const summary = await service.getSummary(10);
    expect(summary.recentEvents).toHaveLength(1);
  });
});
