import { afterEach, describe, expect, it } from "@jest/globals";
import { RATE_LIMIT_POLICIES, shouldPersistRateLimitHit } from "../middleware/rateLimiter.middleware";
import { getRateLimitCategory } from "../security/rate-limit-endpoints";

describe("rateLimiter.middleware", () => {
  it("assigns batch prediction endpoint to prediction category", () => {
    expect(getRateLimitCategory("prediction/batch-submit")).toBe("prediction");
  });

  it("uses stricter batch prediction limits than single submit", () => {
    expect(RATE_LIMIT_POLICIES.predictionBatchSubmit.max).toBeLessThan(
      RATE_LIMIT_POLICIES.predictionSubmit.max,
    );
    expect(RATE_LIMIT_POLICIES.predictionBatchSubmit.windowMs).toBe(
      RATE_LIMIT_POLICIES.predictionSubmit.windowMs,
    );
  });

  it("defines batch leaderboard rate limit policy", () => {
    expect(RATE_LIMIT_POLICIES.leaderboardBatch.max).toBeGreaterThan(0);
    expect(RATE_LIMIT_POLICIES.leaderboardBatch.windowMs).toBeGreaterThan(0);
  });

  it("assigns bet endpoint to prediction category", () => {
    expect(getRateLimitCategory("api/bet")).toBe("prediction");
  });

  it("keeps demo bet/prediction defaults", () => {
    expect(RATE_LIMIT_POLICIES.bet.max).toBe(5);
    expect(RATE_LIMIT_POLICIES.predictionSubmit.max).toBe(10);
    expect(RATE_LIMIT_POLICIES.bet.max).toBeLessThan(
      RATE_LIMIT_POLICIES.predictionSubmit.max,
    );
  });
});

describe("shouldPersistRateLimitHit", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("persists by default", () => {
    delete process.env.RATE_LIMIT_METRICS_ENABLED;
    delete process.env.RATE_LIMIT_METRICS_SAMPLE_RATE;
    expect(shouldPersistRateLimitHit(() => 0.99)).toBe(true);
  });

  it("never persists when RATE_LIMIT_METRICS_ENABLED=false", () => {
    process.env.RATE_LIMIT_METRICS_ENABLED = "false";
    expect(shouldPersistRateLimitHit(() => 0)).toBe(false);
  });

  it("samples according to RATE_LIMIT_METRICS_SAMPLE_RATE", () => {
    process.env.RATE_LIMIT_METRICS_SAMPLE_RATE = "0.25";
    expect(shouldPersistRateLimitHit(() => 0.1)).toBe(true);
    expect(shouldPersistRateLimitHit(() => 0.5)).toBe(false);
  });

  it("handles 0 and invalid sample rates", () => {
    process.env.RATE_LIMIT_METRICS_SAMPLE_RATE = "0";
    expect(shouldPersistRateLimitHit(() => 0)).toBe(false);
    process.env.RATE_LIMIT_METRICS_SAMPLE_RATE = "abc";
    expect(shouldPersistRateLimitHit(() => 0.99)).toBe(true);
  });
});