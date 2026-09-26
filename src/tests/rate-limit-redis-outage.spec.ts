/**
 * Rate-limit outage behavior, fail-open policy (Issue #520).
 *
 * Points REDIS_URL at a closed port BEFORE the rate limiter middleware is
 * loaded, so the limiter is built with the Redis store while every Redis
 * operation fails. Default policy (RATE_LIMIT_REDIS_FAIL_OPEN=true): the
 * store falls back to a per-process window — the API never 500s, and the
 * throttle still holds per instance.
 */
import express from "express";
import request from "supertest";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "250";
process.env.RATE_LIMIT_WRITE_MAX = "3";
process.env.RATE_LIMIT_WRITE_WINDOW_MS = "60000";

// Must load AFTER the env above: the middleware reads them at module load.
const { writeRateLimiter } = require("../middleware/rateLimiter.middleware");

describe("rate limiter with Redis down — fail-open policy (Issue #520)", () => {
  const app = express();
  app.use("/w", writeRateLimiter);
  app.post("/w", (_req, res) => res.sendStatus(200));

  it("still throttles from the per-process fallback window (no 500s, no pass-through)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post("/w");
      statuses.push(res.status);
    }

    // First three requests succeed; the window (max 3) then holds.
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});
