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
