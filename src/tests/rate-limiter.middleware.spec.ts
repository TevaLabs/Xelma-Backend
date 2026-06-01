import { describe, expect, it } from "@jest/globals";
import { RATE_LIMIT_POLICIES } from "../middleware/rateLimiter.middleware";
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
});
