import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  getRedisCircuitBreaker,
  getRedisBreakerSnapshot,
  resetRedisBreaker,
  getRedisCacheTelemetry,
  getCacheMetrics,
  resetCacheMetricsForTest,
  invalidateNamespace,
  getJsonFromCache,
  setJsonToCache,
  closeRedisClient,
} from "../lib/redis";
import { CircuitBreakerOpenError } from "../utils/circuit-breaker";

// Mock the redis module
const mockConnect = jest.fn<() => Promise<void>>();
const mockPing = jest.fn<() => Promise<string>>();
const mockOn = jest.fn();
const mockGet = jest.fn<() => Promise<string | null>>();
const mockSet = jest.fn<() => Promise<string>>();
const mockDel = jest.fn<() => Promise<number>>();
const mockQuit = jest.fn<() => Promise<string>>();

const mockClientInstance = {
  connect: mockConnect,
  ping: mockPing,
  on: mockOn,
  get: mockGet,
  set: mockSet,
  del: mockDel,
  quit: mockQuit,
  isOpen: false,
};

jest.mock("redis", () => ({
  createClient: jest.fn(() => mockClientInstance),
}));

describe("Redis Circuit Breaker and Telemetry (Issue #184)", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      REDIS_URL: "redis://localhost:6379",
      REDIS_CACHE_ENABLED: "true",
      REDIS_CACHE_PREFIX: "xelma:test",
      REDIS_CIRCUIT_FAILURE_THRESHOLD: "2",
      REDIS_FAIL_COOLDOWN_MS: "1000",
    };
    await closeRedisClient();
    resetCacheMetricsForTest();
  });

  afterEach(async () => {
    await closeRedisClient();
    process.env = originalEnv;
  });

  describe("Initial State & Telemetry", () => {
    it("starts with closed circuit breaker and zero failures", () => {
      const snapshot = getRedisBreakerSnapshot();
      expect(snapshot.state).toBe("closed");
      expect(snapshot.failureCount).toBe(0);

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.configured).toBe(true);
      expect(telemetry.enabled).toBe(true);
      expect(telemetry.status).toBe("healthy");
      expect(telemetry.circuitBreaker.state).toBe("closed");
      expect(telemetry.bypassReasons).toEqual({
        unconfigured: 0,
        disabled: 0,
        circuit_open: 0,
        error: 0,
      });
      expect(telemetry.metrics.bypasses).toBe(0);
      expect(telemetry.metrics.hitRatio).toBe(0);
    });

    it("reports status 'bypassed' when REDIS_URL is unconfigured", async () => {
      delete process.env.REDIS_URL;

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.configured).toBe(false);
      expect(telemetry.status).toBe("bypassed");

      await invalidateNamespace("leaderboard");

      const updated = getRedisCacheTelemetry();
      expect(updated.bypassReasons.unconfigured).toBeGreaterThanOrEqual(1);
      expect(updated.metrics.bypasses).toBeGreaterThanOrEqual(1);
    });

    it("reports status 'bypassed' and increments 'disabled' when REDIS_CACHE_ENABLED=false", async () => {
      process.env.REDIS_CACHE_ENABLED = "false";

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.enabled).toBe(false);
      expect(telemetry.status).toBe("bypassed");

      await getJsonFromCache("leaderboard", "top");

      const updated = getRedisCacheTelemetry();
      expect(updated.bypassReasons.disabled).toBeGreaterThanOrEqual(1);
      expect(updated.metrics.bypasses).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Failure handling and Circuit Breaker Tripping", () => {
    it("records failure and increments 'error' bypass on connection failure", async () => {
      mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await invalidateNamespace("leaderboard");

      const snapshot = getRedisBreakerSnapshot();
      expect(snapshot.failureCount).toBe(1);
      expect(snapshot.state).toBe("closed");

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.status).toBe("degraded");
      expect(telemetry.bypassReasons.error).toBe(1);
      expect(telemetry.metrics.errors).toBe(1);
    });

    it("trips circuit breaker to 'open' when failure threshold is reached", async () => {
      mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      // 1st failure
      await invalidateNamespace("leaderboard");
      expect(getRedisBreakerSnapshot().state).toBe("closed");
      expect(getRedisBreakerSnapshot().failureCount).toBe(1);

      // 2nd failure - hits threshold of 2
      await invalidateNamespace("leaderboard");
      const snapshot = getRedisBreakerSnapshot();
      expect(snapshot.state).toBe("open");
      expect(snapshot.failureCount).toBe(2);
      expect(snapshot.nextAttemptAt).toBeDefined();

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.status).toBe("unavailable");
      expect(telemetry.bypassReasons.error).toBe(2);
    });

    it("short-circuits calls and increments 'circuit_open' bypass when breaker is open", async () => {
      mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      // Trigger 2 failures to open the breaker
      await invalidateNamespace("leaderboard");
      await invalidateNamespace("leaderboard");
      expect(getRedisBreakerSnapshot().state).toBe("open");

      const callsBefore = mockConnect.mock.calls.length;

      // Now call getJsonFromCache while breaker is open
      const result = await getJsonFromCache("leaderboard", "top");
      expect(result).toBeNull();

      // No new connection attempt should have been made
      expect(mockConnect.mock.calls.length).toBe(callsBefore);

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.bypassReasons.circuit_open).toBeGreaterThanOrEqual(1);
      expect(telemetry.status).toBe("unavailable");
    });

    it("resets breaker to closed with resetRedisBreaker()", async () => {
      mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      await invalidateNamespace("leaderboard");
      await invalidateNamespace("leaderboard");
      expect(getRedisBreakerSnapshot().state).toBe("open");

      resetRedisBreaker();

      const snapshot = getRedisBreakerSnapshot();
      expect(snapshot.state).toBe("closed");
      expect(snapshot.failureCount).toBe(0);

      const telemetry = getRedisCacheTelemetry();
      expect(telemetry.status).toBe("healthy");
    });
  });

  describe("Backward Compatibility of getCacheMetrics", () => {
    it("includes hitRatio, circuitBreaker, and bypassReasons", () => {
      const cacheMetrics = getCacheMetrics();
      expect(cacheMetrics).toHaveProperty("hits");
      expect(cacheMetrics).toHaveProperty("misses");
      expect(cacheMetrics).toHaveProperty("bypasses");
      expect(cacheMetrics).toHaveProperty("hitRatio");
      expect(cacheMetrics).toHaveProperty("circuitBreaker");
      expect(cacheMetrics).toHaveProperty("bypassReasons");
      expect(cacheMetrics.bypassReasons).toMatchObject({
        unconfigured: expect.any(Number),
        disabled: expect.any(Number),
        circuit_open: expect.any(Number),
        error: expect.any(Number),
      });
    });
  });
});
