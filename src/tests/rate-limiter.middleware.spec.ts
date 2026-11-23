import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { RATE_LIMIT_POLICIES, challengeRateLimiter } from "../middleware/rateLimiter.middleware";
import { getRateLimitCategory } from "../security/rate-limit-endpoints";

jest.mock("../services/rate-limit-metrics.service", () => ({
  rateLimitMetricsService: { recordHit: jest.fn() },
  RateLimitMetricsService: { recordHit: jest.fn() },
}));

import { rateLimitMetricsService } from "../services/rate-limit-metrics.service";

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

/**
 * Tests for Issue #1020: optional rate-limit metrics persistence gated by
 * RATE_LIMIT_METRICS_ENABLED.
 */
describe("rate-limit metrics persistence (Issue #1020)", () => {
  const app = express();
  app.use("/challenge", challengeRateLimiter);
  app.get("/challenge/_ok", (_req, res) => res.sendStatus(200));

  // challengeRateLimiter caps at 5 hits per window; send 6 to force a 429.
  const exhaust = async () => {
    for (let i = 0; i < 6; i++) {
      await request(app).get("/challenge/_ok");
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RATE_LIMIT_METRICS_ENABLED = "false";
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_METRICS_ENABLED;
  });

  it("does not persist rate-limit hits when RATE_LIMIT_METRICS_ENABLED is false", async () => {
    await exhaust();
    expect(rateLimitMetricsService.recordHit).not.toHaveBeenCalled();
  });

  it("persists rate-limit hits when RATE_LIMIT_METRICS_ENABLED is true", async () => {
    process.env.RATE_LIMIT_METRICS_ENABLED = "true";
    await exhaust();
    expect(rateLimitMetricsService.recordHit).toHaveBeenCalled();
  });
});
