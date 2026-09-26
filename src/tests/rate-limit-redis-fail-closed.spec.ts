/**
 * Rate-limit outage behavior, fail-closed policy (Issue #520).
 *
 * Same setup as rate-limit-redis-outage.spec.ts but with
 * RATE_LIMIT_REDIS_FAIL_OPEN=false: when the Redis-backed store cannot be
 * reached the increment throws, so express-rate-limit rejects the request
 * instead of letting it through unthrottled. Operators who consider shared
 * throttling a hard requirement choose this mode.
 */
import express from "express";
import request from "supertest";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "250";
process.env.RATE_LIMIT_REDIS_FAIL_OPEN = "false";
process.env.RATE_LIMIT_WRITE_MAX = "3";
process.env.RATE_LIMIT_WRITE_WINDOW_MS = "60000";

// Must load AFTER the env above: the middleware reads them at module load.
const { writeRateLimiter } = require("../middleware/rateLimiter.middleware");

describe("rate limiter with Redis down — fail-closed policy (Issue #520)", () => {
  const app = express();
  app.use("/w", writeRateLimiter);
  app.post("/w", (_req, res) => res.sendStatus(200));

  it("rejects requests while the Redis store is unreachable", async () => {
    // Store increments throw → express-rate-limit forwards to the error
    // handler, which answers 500. No request is served unthrottled.
    const res = await request(app).post("/w");
    expect(res.status).toBe(500);
  });
});
