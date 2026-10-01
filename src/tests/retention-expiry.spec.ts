/**
 * Retention policies delete expired auth challenges and idempotency keys and
 * keeps live ones (no mocks; runs against the in-memory store, so no DB needed).
 */
process.env.DATA_STORE = "memory";
process.env.DATA_MODE = "mock";

import { describe, it, expect, beforeEach } from "@jest/globals";
import retentionService from "../services/retention.service";
import { prisma } from "../lib/prisma";
import {
  checkIdempotency,
  cleanupExpiredIdempotencyKeys,
  resetInMemoryIdempotencyStore,
  storeIdempotencyResult,
} from "../utils/idempotency.util";

const WALLET = "GTESTRETENTION1111111111111111111111111111111111111111111";
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

describe("retention: expired challenges and idempotency keys", () => {
  beforeEach(async () => {
    resetInMemoryIdempotencyStore();
    await prisma.authChallenge.deleteMany({});
  });

  it("removes expired auth challenges and keeps unexpired ones", async () => {
    await prisma.authChallenge.create({
      data: { challenge: "expired-c", walletAddress: WALLET, expiresAt: minutes(-5) },
    });
    await prisma.authChallenge.create({
      data: { challenge: "live-c", walletAddress: WALLET, expiresAt: minutes(5) },
    });

    const result = await retentionService.cleanupAuthChallenges();

    expect(result.deletedCount).toBe(1);
    expect(await prisma.authChallenge.findUnique({ where: { challenge: "expired-c" } })).toBeNull();
    expect(await prisma.authChallenge.findUnique({ where: { challenge: "live-c" } })).not.toBeNull();
  });

  it("removes expired idempotency keys and keeps unexpired ones", async () => {
    const body = { amount: 1 };
    await storeIdempotencyResult("u1", "/e", "expired-k", body, 200, { ok: 1 }, { ttlMinutes: -5 });
    await storeIdempotencyResult("u1", "/e", "live-k", body, 200, { ok: 1 }, { ttlMinutes: 5 });

    const deleted = await cleanupExpiredIdempotencyKeys();

    expect(deleted).toBe(1);
    expect((await checkIdempotency("u1", "/e", "expired-k", body)).isIdempotent).toBe(false);
    expect((await checkIdempotency("u1", "/e", "live-k", body)).isIdempotent).toBe(true);
  });
});
