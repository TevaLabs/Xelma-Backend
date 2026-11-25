import { describe, expect, it } from "@jest/globals";
import express from "express";
import supertest from "supertest";
import { RATE_LIMIT_POLICIES, betRateLimiter } from "../middleware/rateLimiter.middleware";
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

  it("sets Retry-After header on 429 responses (Issue #1057)", async () => {
    const app = express();
    app.use(betRateLimiter);
    app.get("/bet", (_req, res) => res.json({ ok: true }));

    const agent = supertest(app);
    // betRateLimiter: max=5, windowMs=60s -> Retry-After = 60s
    for (let i = 0; i < RATE_LIMIT_POLICIES.bet.max; i += 1) {
      await agent.get("/bet").expect(200);
    }
    const res = await agent.get("/bet").expect(429);
    expect(res.headers["retry-after"]).toBe(
      String(Math.ceil(RATE_LIMIT_POLICIES.bet.windowMs / 1000)),
    );
  });
});
