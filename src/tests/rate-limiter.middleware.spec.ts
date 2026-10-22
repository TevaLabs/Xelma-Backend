import { describe, expect, it } from "@jest/globals";
import { RATE_LIMIT_POLICIES, connectWalletKey } from "../middleware/rateLimiter.middleware";
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

  describe("connectWalletKey", () => {
    const req = (ip: string, body: unknown) => ({ ip, body, socket: {} }) as any;

    it("separates wallets from the same IP", () => {
      expect(connectWalletKey(req("1.2.3.4", { walletAddress: "GA" }))).not.toBe(
        connectWalletKey(req("1.2.3.4", { walletAddress: "GB" })),
      );
    });

    it("separates IPs for the same wallet", () => {
      expect(connectWalletKey(req("1.2.3.4", { walletAddress: "GA" }))).not.toBe(
        connectWalletKey(req("5.6.7.8", { walletAddress: "GA" })),
      );
    });

    it("is case-insensitive on wallet and tolerates a missing wallet", () => {
      expect(connectWalletKey(req("1.2.3.4", { walletAddress: "ga" }))).toBe(
        connectWalletKey(req("1.2.3.4", { walletAddress: "GA" })),
      );
      expect(connectWalletKey(req("1.2.3.4", undefined))).toContain("no-wallet");
    });
  });

  it("assigns the per-wallet connect limiter to the auth category", () => {
    expect(getRateLimitCategory("auth/connect-wallet")).toBe("auth");
  });
});
