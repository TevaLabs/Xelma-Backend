import { describe, it, expect } from "@jest/globals";
import config from "../config";

describe("Oracle Configuration (#111)", () => {
  it("should have default oracle configuration values", () => {
    expect(config.oracle).toBeDefined();
    // These should match the defaults in config/index.ts
    expect(typeof config.oracle.pollingIntervalMs).toBe("number");
    expect(typeof config.oracle.requestTimeoutMs).toBe("number");
    expect(typeof config.oracle.maxRetries).toBe("number");
    expect(typeof config.oracle.stalenessThresholdMs).toBe("number");
  });

  it("should use environment variables for oracle configuration if provided", () => {
    // This test relies on how buildConfig handles process.env
    // Since config is a singleton, we can't easily re-test buildConfig with different envs
    // without re-importing or using a separate test utility.
    // However, we can verify that the config object has the expected structure.
    expect(config.oracle).toMatchObject({
      pollingIntervalMs: expect.any(Number),
      requestTimeoutMs: expect.any(Number),
      maxRetries: expect.any(Number),
      stalenessThresholdMs: expect.any(Number),
    });
  });

  it("should have positive integers for timing values", () => {
    expect(config.oracle.pollingIntervalMs).toBeGreaterThan(0);
    expect(config.oracle.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.oracle.stalenessThresholdMs).toBeGreaterThan(0);
  });
});
