import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  getCacheMetrics,
  resetCacheMetrics,
  redisCircuitBreaker,
  getRedisCircuitBreakerSnapshot,
  resetRedisCircuitBreaker,
  getRedisTelemetry,
  checkRedisHealth,
  getJsonFromCache,
  setJsonToCache,
  isRedisCacheEnabled,
} from "../lib/redis";
import {
  metricsRegistry,
  redisCacheBypassesByReasonTotal,
  redisCacheHealthy,
  redisCacheHitRatio,
} from "../metrics/application.metrics";

describe("Redis Circuit Breaker & Bypass Telemetry (Issue #184)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    resetCacheMetrics();
    resetRedisCircuitBreaker();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRedisCircuitBreaker();
  });

  describe("Circuit Breaker State & Reset", () => {
    it("starts in closed state with 0 failures", () => {
      const snapshot = getRedisCircuitBreakerSnapshot();
      expect(snapshot.name).toBe("redis-cache");
      expect(snapshot.state).toBe("closed");
      expect(snapshot.failureCount).toBe(0);
      expect(snapshot.halfOpenInFlight).toBe(0);
    });

    it("resets cleanly via resetRedisCircuitBreaker", () => {
      resetRedisCircuitBreaker();
      const snapshot = getRedisCircuitBreakerSnapshot();
      expect(snapshot.state).toBe("closed");
      expect(snapshot.failureCount).toBe(0);
    });
  });

  describe("Bypass Reason Tracking", () => {
    it("tracks bypass reason 'disabled' when REDIS_CACHE_ENABLED=false", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CACHE_ENABLED = "false";

      const val = await getJsonFromCache("test:key");
      expect(val).toBeNull();

      const metrics = getCacheMetrics();
      expect(metrics.bypasses).toBeGreaterThan(0);
      expect(metrics.bypassesByReason.disabled).toBeGreaterThan(0);
    });

    it("tracks bypass reason 'unconfigured' when REDIS_URL is empty", async () => {
      delete process.env.REDIS_URL;
      process.env.REDIS_CACHE_ENABLED = "true";

      const val = await getJsonFromCache("test:key");
      expect(val).toBeNull();

      const metrics = getCacheMetrics();
      expect(metrics.bypasses).toBeGreaterThan(0);
      expect(metrics.bypassesByReason.unconfigured).toBeGreaterThan(0);
    });

    it("tracks bypass reason 'circuit_open' when circuit breaker is open", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CACHE_ENABLED = "true";

      // Manually trip the circuit breaker
      (redisCircuitBreaker as any).transitionTo("open", "test_failure");
      expect(getRedisCircuitBreakerSnapshot().state).toBe("open");

      const val = await getJsonFromCache("test:key");
      expect(val).toBeNull();

      const metrics = getCacheMetrics();
      expect(metrics.bypassesByReason.circuit_open).toBeGreaterThan(0);
    });
  });

  describe("Health Check Degradation", () => {
    it("reports degraded health when circuit breaker is open and cache is enabled", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CACHE_ENABLED = "true";

      (redisCircuitBreaker as any).open("upstream_error");

      const health = await checkRedisHealth(1000);
      expect(health.status).toBe("degraded");
      expect(health.error).toContain("Circuit breaker");
    });
  });

  describe("Telemetry Snapshot Aggregation", () => {
    it("returns comprehensive snapshot from getRedisTelemetry", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CACHE_ENABLED = "true";

      const telemetry = getRedisTelemetry();
      expect(telemetry).toHaveProperty("metrics");
      expect(telemetry).toHaveProperty("circuitBreaker");
      expect(telemetry).toHaveProperty("enabled");
      expect(telemetry).toHaveProperty("configured");
      expect(telemetry).toHaveProperty("status");
      expect(telemetry.circuitBreaker.name).toBe("redis-cache");
      expect(telemetry.metrics.bypassesByReason).toBeDefined();
    });
  });

  describe("Prometheus Metrics Registration", () => {
    it("collects bypasses by reason into Prometheus gauge", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_CACHE_ENABLED = "false";
      await getJsonFromCache("prom:test:key");

      const metricsString = await metricsRegistry.metrics();
      expect(metricsString).toContain("redis_cache_bypasses_by_reason_total");
      expect(metricsString).toContain('reason="disabled"');
    });

    it("evaluates redis_cache_healthy Prometheus gauge accurately", async () => {
      delete process.env.REDIS_URL;
      const metricsString = await metricsRegistry.metrics();
      expect(metricsString).toContain("redis_cache_healthy");
    });
  });
});
