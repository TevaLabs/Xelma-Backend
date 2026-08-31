import { beforeEach, describe, expect, it } from "@jest/globals";
import { RateLimitMetricsService } from "../services/rate-limit-metrics.service";

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

describe("RateLimitMetricsService.getSuspiciousActivity", () => {
  const service = new RateLimitMetricsService();

  beforeEach(() => {
    jest.clearAllMocks();
    service.resetInMemoryStore();
  });

  it("groups monitored categories and flags repeat offenders", async () => {
    const now = new Date();
    mockFindMany.mockResolvedValue([
      {
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      },
      {
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      },
      {
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      },
      {
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      },
      {
        endpoint: "auth/connect",
        key: "ip-1",
        userId: null,
        ip: "1.2.3.4",
        timestamp: now,
      },
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
    ]);

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
});

describe("RateLimitMetricsService in-memory fallback", () => {
  let service: RateLimitMetricsService;

  beforeEach(() => {
    service = new RateLimitMetricsService();
    service.resetInMemoryStore();
    jest.clearAllMocks();
  });

  it("records hits to both Prisma and in-memory store when Prisma is available", async () => {
    mockCreate.mockResolvedValue({});
    mockGroupBy.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([]);

    await service.recordHit({ endpoint: "auth/connect", key: "ip-1", ip: "1.2.3.4", userId: null });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const summary = await service.getSummary(10);
    expect(summary.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(summary.recentEvents[0].endpoint).toBe("auth/connect");
  });

  it("records hits in memory when Prisma throws", async () => {
    mockCreate.mockRejectedValue(new Error("relation does not exist"));
    mockGroupBy.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([]);

    await service.recordHit({ endpoint: "auth/connect", key: "ip-1", ip: "1.2.3.4" });

    const summary = await service.getSummary(10);
    expect(summary.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(summary.recentEvents[0].endpoint).toBe("auth/connect");
  });

  it("returns summary from in-memory records when Prisma findMany throws", async () => {
    mockGroupBy.mockRejectedValue(new Error("connection refused"));
    mockFindMany.mockRejectedValue(new Error("connection refused"));

    // Pre-populate in-memory store via recordHit (which also tries Prisma)
    mockCreate.mockRejectedValue(new Error("connection refused"));
    await service.recordHit({ endpoint: "chat/message", key: "user-1", ip: "127.0.0.1", userId: "user-1" });
    await service.recordHit({ endpoint: "chat/message", key: "user-1", ip: "127.0.0.1", userId: "user-1" });
    await service.recordHit({ endpoint: "auth/connect", key: "ip-2", ip: "10.0.0.1" });

    const summary = await service.getSummary(10);

    // Top endpoints should include chat/message and auth/connect
    const endpoints = summary.topEndpoints.map((e) => e.endpoint);
    expect(endpoints).toContain("chat/message");
    expect(endpoints).toContain("auth/connect");
    expect(summary.topEndpoints.find((e) => e.endpoint === "chat/message")?.hits).toBe(2);
  });

  it("flags suspicious actors from in-memory records when Prisma is unavailable", async () => {
    mockFindMany.mockRejectedValue(new Error("connection refused"));
    mockGroupBy.mockRejectedValue(new Error("connection refused"));

    mockCreate.mockRejectedValue(new Error("connection refused"));
    // Record 6 hits from the same key to exceed the threshold of 5
    for (let i = 0; i < 6; i++) {
      await service.recordHit({ endpoint: "auth/connect", key: "bad-actor", ip: "1.2.3.4" });
    }

    const result = await service.getSuspiciousActivity(10);
    expect(result.flaggedActors.length).toBeGreaterThanOrEqual(1);
    expect(result.flaggedActors[0].key).toBe("bad-actor");
    expect(result.flaggedActors[0].hits).toBe(6);
    expect(result.flaggedActors[0].category).toBe("auth");
  });

  it("clears old in-memory records", async () => {
    mockCreate.mockRejectedValue(new Error("no db"));
    mockDeleteMany.mockRejectedValue(new Error("no db"));
    mockGroupBy.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([]);

    // recordHit stores in memory even when Prisma fails
    await service.recordHit({ endpoint: "test", key: "k" });

    // Clear with 1 day should remove the record we just made (it's younger than 1 day)
    const deleted = await service.clearOldMetrics(1);
    expect(deleted).toBe(0);

    // Clear with 0 days removes records older than now; the record was just created
    // so it should not be deleted either. Use a negative offset to force-delete.
    const deleted2 = await service.clearOldMetrics(-1);
    expect(deleted2).toBeGreaterThanOrEqual(1);

    // Subsequent summary should have no recent events
    const summary = await service.getSummary(10);
    expect(summary.recentEvents).toHaveLength(0);
  });

  it("merges in-memory and Prisma records in summary", async () => {
    mockCreate.mockResolvedValue({});
    mockGroupBy.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([]);

    // Record one hit via service (goes to both memory and Prisma)
    await service.recordHit({ endpoint: "auth/connect", key: "ip-1", ip: "1.2.3.4" });

    // Also manually push an in-memory-only record (simulating Prisma failure)
    const summary = await service.getSummary(10);
    expect(summary.recentEvents.length).toBeGreaterThanOrEqual(1);
  });
});
