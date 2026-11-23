/**
 * Issue #967 — `/api/auth/connect` is throttled per wallet *and* per IP.
 *
 * These tests mount the real limiter (no module mock) on a throwaway app, so
 * the assertions cover the actual composition, key generation, and the
 * `Retry-After` header rather than a passthrough stub.
 */
import express, { Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeAll } from "@jest/globals";
import { connectRateLimiter } from "../middleware/rateLimiter.middleware";

// Keep the hit-recording side effect in memory so the suite never touches a DB.
jest.mock("../services/rate-limit-metrics.service", () => ({
  RateLimitMetricsService: { recordHit: jest.fn() },
  rateLimitMetricsService: { recordHit: jest.fn().mockResolvedValue(undefined) },
}));

const IP_LIMIT = 5;
const WALLET_LIMIT = 5;
const WINDOW_SECONDS = 15 * 60;

describe("/api/auth/connect rate limiting (#967)", () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    // One trusted proxy hop so X-Forwarded-For gives each request a stable IP.
    app.set("trust proxy", 1);
    app.use(express.json());
    app.post("/connect", connectRateLimiter, (_req, res) => {
      res.status(200).json({ ok: true });
    });
  });

  it("throttles a single wallet across many IPs and sets Retry-After", async () => {
    const wallet = "GWALLETSPRAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let limited: request.Response | undefined;

    for (let i = 0; i < WALLET_LIMIT + 1; i += 1) {
      const res = await request(app)
        .post("/connect")
        .set("X-Forwarded-For", `203.0.113.${i + 1}`)
        .send({ walletAddress: wallet });

      if (i < WALLET_LIMIT) {
        expect(res.status).toBe(200);
      } else {
        limited = res;
      }
    }

    expect(limited?.status).toBe(429);
    expect(limited?.body.message).toMatch(/wallet/i);
    expect(limited?.body.retryAfter).toBe(WINDOW_SECONDS);
    expect(limited?.headers["retry-after"]).toBe(String(WINDOW_SECONDS));
  });

  it("throttles a single IP across many wallets and sets Retry-After", async () => {
    const ip = "198.51.100.7";
    let limited: request.Response | undefined;

    for (let i = 0; i < IP_LIMIT + 1; i += 1) {
      const res = await request(app)
        .post("/connect")
        .set("X-Forwarded-For", ip)
        .send({
          walletAddress: `GIPSWEEP${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        });

      if (i < IP_LIMIT) {
        expect(res.status).toBe(200);
      } else {
        limited = res;
      }
    }

    expect(limited?.status).toBe(429);
    expect(limited?.body.message).toMatch(/IP/i);
    expect(limited?.headers["retry-after"]).toBe(String(WINDOW_SECONDS));
  });

  it("treats case variants of the same wallet as one bucket", async () => {
    const wallet = "GCASEVARIANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let limited: request.Response | undefined;

    for (let i = 0; i < WALLET_LIMIT + 1; i += 1) {
      const res = await request(app)
        .post("/connect")
        .set("X-Forwarded-For", `192.0.2.${i + 1}`)
        .send({ walletAddress: i % 2 === 0 ? wallet : wallet.toLowerCase() });

      if (i < WALLET_LIMIT) {
        expect(res.status).toBe(200);
      } else {
        limited = res;
      }
    }

    expect(limited?.status).toBe(429);
    expect(limited?.body.message).toMatch(/wallet/i);
  });
});
