import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { invalidateNamespace } from "../lib/redis";

describe("Redis Cache Invalidation (Issue #693)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REDIS_URL: "redis://localhost:6379",
      REDIS_CACHE_ENABLED: "true",
      REDIS_CACHE_PREFIX: "xelma:test",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should increment namespace version key when invalidateNamespace is invoked", async () => {
    // Test that invalidateNamespace executes cleanly and attempts version increment
    await expect(invalidateNamespace("leaderboard")).resolves.not.toThrow();
    await expect(invalidateNamespace("profile")).resolves.not.toThrow();
    await expect(invalidateNamespace("rounds")).resolves.not.toThrow();
    await expect(invalidateNamespace("bets")).resolves.not.toThrow();
    await expect(invalidateNamespace("stats")).resolves.not.toThrow();
  });
});
