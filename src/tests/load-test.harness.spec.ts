import { describe, it, expect } from "@jest/globals";
import {
  computeLatencyStats,
  getLoadTestConfig,
  percentile,
  runConcurrentLoad,
  summarizeLoadTest,
} from "./load-test.harness";

describe("load-test.harness (#21)", () => {
  describe("percentile helpers", () => {
    it("computes nearest-rank percentiles on sorted input", () => {
      const sorted = [10, 20, 30, 40, 50];
      expect(percentile(sorted, 50)).toBe(30);
      expect(percentile(sorted, 95)).toBe(50);
      expect(percentile(sorted, 99)).toBe(50);
    });

    it("returns zeros for empty latency arrays", () => {
      expect(computeLatencyStats([])).toEqual({
        min: 0,
        max: 0,
        mean: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      });
    });

    it("summarizes throughput from samples", () => {
      const summary = summarizeLoadTest(
        [
          { success: true, latencyMs: 10 },
          { success: true, latencyMs: 20 },
          { success: false, latencyMs: 30 },
        ],
        1000
      );

      expect(summary.total).toBe(3);
      expect(summary.successes).toBe(2);
      expect(summary.failures).toBe(1);
      expect(summary.throughputRps).toBe(3);
      expect(summary.latencyMs.p50).toBe(20);
    });
  });

  describe("runConcurrentLoad", () => {
    it("respects concurrency and iteration counts", async () => {
      let inFlight = 0;
      let maxInFlight = 0;

      const result = await runConcurrentLoad({
        concurrency: 3,
        iterations: 9,
        task: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { success: true, latencyMs: 5 };
        },
      });

      expect(result.total).toBe(9);
      expect(result.successes).toBe(9);
      expect(maxInFlight).toBeLessThanOrEqual(3);
    });
  });

  describe("getLoadTestConfig", () => {
    it("falls back to documented defaults when env is unset", () => {
      const config = getLoadTestConfig();
      expect(config.prediction.concurrency).toBeGreaterThan(0);
      expect(config.prediction.iterations).toBeGreaterThan(0);
      expect(config.websocket.clientCount).toBeGreaterThan(0);
      expect(config.baseline.challengeLatencyMs).toBe(200);
    });
  });
});
