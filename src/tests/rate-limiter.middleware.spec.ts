import { describe, expect, it } from "@jest/globals";
import {
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_LIVENESS_SKIP_PATHS,
  isLivenessSkipPath,
} from "../middleware/rateLimiter.middleware";
import { getRateLimitCategory } from "../security/rate-limit-endpoints";

const req = (originalUrl: string) => ({ originalUrl }) as any;

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

  describe("liveness skip list (Issue #724)", () => {
    it("documents the liveness paths exempt from the global limiter", () => {
      expect(RATE_LIMIT_LIVENESS_SKIP_PATHS).toEqual(["/health", "/api/health"]);
    });

    it.each(["/health", "/api/health", "/api/health?ready=0"]) (
      "skips liveness path %s",
      (url) => {
        expect(isLivenessSkipPath(req(url))).toBe(true);
      },
    );

    it.each(["/api/bets", "/api/healthz", "/api/health/ready", "/api/rounds"]) (
      "does not skip non-liveness path %s",
      (url) => {
        expect(isLivenessSkipPath(req(url))).toBe(false);
      },
    );
  });
});
