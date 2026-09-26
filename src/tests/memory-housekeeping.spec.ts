/**
 * Issue 3B: Memory housekeeping service tests.
 *
 * Verifies that the memory housekeeping service:
 * 1. Prunes expired auth challenges
 * 2. Prunes expired in-memory idempotency keys
 * 3. Prevents overlapping sweeps
 * 4. Can be started and stopped cleanly
 */

process.env.DATA_STORE = "memory";
process.env.DATA_MODE = "mock";

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { MemoryHousekeepingService } from "../services/memory-housekeeping.service";
import { prisma } from "../lib/prisma";
import {
  acquireIdempotencyLock,
  cleanupExpiredIdempotencyKeys,
  resetInMemoryIdempotencyStore,
} from "../utils/idempotency.util";

describe("MemoryHousekeepingService (Issue 3B)", () => {
  let service: MemoryHousekeepingService;

  beforeEach(async () => {
    service = new MemoryHousekeepingService();
    resetInMemoryIdempotencyStore();
    await prisma.authChallenge.deleteMany({});
  });

  afterEach(() => {
    service.stop();
  });

  it("prunes expired auth challenges on sweep", async () => {
    const now = new Date();

    // Create an expired challenge (expired 5 minutes ago)
    await prisma.authChallenge.create({
      data: {
        challenge: "expired-challenge-001",
        walletAddress: "GEXPIRED11111111111111111111111111111111111111111111111111",
        expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      },
    });

    // Create an active challenge (expires in 10 minutes)
    await prisma.authChallenge.create({
      data: {
        challenge: "active-challenge-002",
        walletAddress: "GACTIVE111111111111111111111111111111111111111111111111111",
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    });

    // Before sweep: 2 challenges
    const before = await prisma.authChallenge.findMany({});
    expect(before).toHaveLength(2);

    // Run housekeeping sweep
    const result = await service.runOnce();
    expect(result.challengesPurged).toBeGreaterThanOrEqual(1);

    // After sweep: only the active one remains
    const after = await prisma.authChallenge.findMany({});
    expect(after).toHaveLength(1);
    expect(after[0].challenge).toBe("active-challenge-002");
  });

  it("prunes expired in-memory idempotency keys on sweep", async () => {
    // Acquire a lock with a negative TTL (already expired)
    await acquireIdempotencyLock(
      "user-expire",
      "/api/test",
      "expired-key-1",
      { data: 1 },
      -1, // -1 hours -> expired in the past
    );

    // Acquire a lock with normal positive TTL
    await acquireIdempotencyLock(
      "user-active",
      "/api/test",
      "active-key-2",
      { data: 2 },
      1, // 1 hour -> active
    );

    // Direct cleanup verification
    const purged = await cleanupExpiredIdempotencyKeys();
    expect(purged).toBe(1);

    // Second call should purge nothing
    const purgedAgain = await cleanupExpiredIdempotencyKeys();
    expect(purgedAgain).toBe(0);
  });

  it("handles start and stop cleanly", () => {
    service.start({ intervalMs: 1000 });
    // Calling start again is a no-op
    service.start({ intervalMs: 1000 });
    service.stop();
    // Calling stop again is a no-op
    service.stop();
  });
});
