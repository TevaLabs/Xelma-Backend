/**
 * Redis-backed rate-limit store integration test (Issue #520).
 *
 * Exercises the actual Lua scripts against a real Redis to prove the
 * cross-instance sharing property: two store instances (two replicas) with the
 * same prefix and client see cumulative counts, and counters are independent
 * per prefix. Skips cleanly when REDIS_URL is not configured so the default
 * test run never needs a Redis server.
 *
 * To run locally:
 *   docker compose up -d redis
 *   REDIS_URL=redis://localhost:6379 npx jest --selectProjects integration --testPathPattern=rate-limit-redis-store.integration
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createClient, type RedisClientType } from "redis";
import { RedisRateLimitStore } from "../lib/redis";

const REDIS_URL = process.env.REDIS_URL;
const maybeDescribe = REDIS_URL ? describe : describe.skip;

const TEST_PREFIX_A = "xelma:test:rl:a:";
const TEST_PREFIX_B = "xelma:test:rl:b:";

function makeStore(prefix: string, client: RedisClientType, windowMs: number) {
  const store = new RedisRateLimitStore({ prefix, getClient: async () => client });
  store.init({ windowMs } as any);
  return store;
}

maybeDescribe("RedisRateLimitStore with real Redis (Issue #520)", () => {
  let client: RedisClientType;

  beforeAll(async () => {
    client = createClient({
      url: REDIS_URL,
      socket: { connectTimeout: 2_000, reconnectStrategy: () => new Error("stop") },
    });
    client.on("error", () => undefined);
    await client.connect();
    await client.ping();
    // Start from a clean keyspace for this test prefix.
    const keys = await client.keys(`${TEST_PREFIX_A}*`);
    if (keys.length > 0) await client.del(keys);
  }, 10_000);

  afterAll(async () => {
    // Clean up the keys this suite created.
    const keys = await client.keys(`${TEST_PREFIX_A}*`);
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  }, 10_000);

  it("shares counts across store instances (multi-replica)", async () => {
    // Two store instances over the same Redis client = two replicas sharing
    // one keyspace. Both must observe cumulative hits.
    const replicaA = makeStore(TEST_PREFIX_A, client, 60_000);
    const replicaB = makeStore(TEST_PREFIX_A, client, 60_000);
    const key = `shared-${Date.now()}`;

    const hitA = await replicaA.increment(key);
    const hitB = await replicaB.increment(key);
    const hitA2 = await replicaA.increment(key);

    expect(hitA.totalHits).toBe(1);
    expect(hitB.totalHits).toBe(2);
    expect(hitA2.totalHits).toBe(3);
    expect(hitA2.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps counters independent across prefixes (stacked limiters)", async () => {
    const storeA = makeStore(TEST_PREFIX_A, client, 60_000);
    const storeB = makeStore(TEST_PREFIX_B, client, 60_000);
    const key = `prefixed-${Date.now()}`;

    expect((await storeA.increment(key)).totalHits).toBe(1);
    expect((await storeB.increment(key)).totalHits).toBe(1);
    expect((await storeA.increment(key)).totalHits).toBe(2);
    expect((await storeB.increment(key)).totalHits).toBe(2);
  });

  it("resets the fixed window after the window elapses", async () => {
    const store = makeStore(TEST_PREFIX_A, client, 150);
    const key = `window-${Date.now()}`;

    expect((await store.increment(key)).totalHits).toBe(1);
    expect((await store.increment(key)).totalHits).toBe(2);

    // Wait for the window to lapse, then the counter must start over.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await store.increment(key);
    expect(after.totalHits).toBe(1);
  }, 10_000);

  it("decrement and resetKey mutate the shared counter", async () => {
    const store = makeStore(TEST_PREFIX_A, client, 60_000);
    const key = `mutate-${Date.now()}`;

    await store.increment(key);
    await store.increment(key);
    await store.decrement(key);
    expect((await store.increment(key)).totalHits).toBe(2);

    await store.resetKey(key);
    expect((await store.increment(key)).totalHits).toBe(1);
  });
});

if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    "[rate-limit-redis-store.integration.spec.ts] REDIS_URL not set - skipping shared rate-limit store test. " +
      "Run `docker compose up -d redis` and set REDIS_URL to enable it."
  );
}
