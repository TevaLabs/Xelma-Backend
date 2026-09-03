/**
 * Unit tests for the Redis-backed express-rate-limit store (Issue #520).
 *
 * These never touch a real Redis server: the store's client is injected as a
 * small fake that mirrors the fixed-window semantics of the Lua scripts, and
 * outages are simulated with a provider that resolves `null`. The Lua scripts
 * themselves are exercised against real Redis in
 * `rate-limit-redis-store.integration.spec.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  RedisRateLimitStore,
  isRedisRateLimitConfigured,
} from "../lib/redis";

/** Fake Redis client that understands the store's EVAL/DEL usage. */
class FakeRateLimitRedis {
  /** key -> { count, resetAtMs } */
  private readonly data = new Map<string, { count: number; resetAtMs: number }>();

  async sendCommand(args: string[]): Promise<unknown> {
    const [command, script, numKeys, ...rest] = args;
    if (command === "DEL") {
      this.data.delete(args[1]);
      return 1;
    }
    if (command !== "EVAL") {
      throw new Error(`Unexpected command ${command}`);
    }
    const key = rest[0];
    if (script.includes("count', -1")) {
      // Decrement script: never below zero.
      const entry = this.data.get(key);
      if (entry) {
        entry.count = Math.max(0, entry.count - 1);
      }
      return this.data.get(key)?.count ?? 0;
    }
    // Increment script: fixed window anchored at the first request.
    const keyCount = Number(numKeys);
    const scriptArgs = rest.slice(keyCount);
    const now = Number(scriptArgs[0]);
    const windowMs = Number(scriptArgs[1]);
    const entry = this.data.get(key);
    if (!entry || now >= entry.resetAtMs) {
      this.data.set(key, { count: 0, resetAtMs: now + windowMs });
    }
    const current = this.data.get(key)!;
    current.count += 1;
    // HGET replies are bulk strings in RESP, so report reset as a string to
    // exercise the store's parsing of mixed [number, string] EVAL replies.
    return [current.count, String(current.resetAtMs)];
  }

  async del(key: string): Promise<number> {
    this.data.delete(key);
    return 1;
  }

  countFor(key: string): number {
    return this.data.get(key)?.count ?? 0;
  }
}

function makeStore(options: {
  prefix: string;
  client?: FakeRateLimitRedis;
  failOpen?: boolean;
  onOutage?: () => void;
}) {
  const client = options.client ?? new FakeRateLimitRedis();
  const store = new RedisRateLimitStore({
    prefix: options.prefix,
    failOpen: options.failOpen,
    getClient: async () => client as any,
    onOutage: options.onOutage,
  });
  return { store, client };
}

describe("RedisRateLimitStore (Issue #520)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1_000_000_000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("is never instance-local (localKeys=false)", () => {
    const { store } = makeStore({ prefix: "xelma:rl:test:" });
    expect(store.localKeys).toBe(false);
  });

  it("captures the fixed window from init()", async () => {
    const { store } = makeStore({ prefix: "xelma:rl:test:" });
    store.init({ windowMs: 5_000 } as any);
    const first = await store.increment("client-1");
    expect(first.totalHits).toBe(1);
    expect(first.resetTime!.getTime()).toBe(Date.now() + 5_000);
  });

  it("counts shared clients across separate store instances (replicas)", async () => {
    const sharedClient = new FakeRateLimitRedis();
    // Two store instances over the same Redis client = two replicas sharing
    // one keyspace. Distinct store objects, same prefix.
    const replicaA = makeStore({ prefix: "xelma:rl:shared:", client: sharedClient });
    const replicaB = makeStore({ prefix: "xelma:rl:shared:", client: sharedClient });

    await replicaA.store.init({ windowMs: 60_000 } as any);
    await replicaB.store.init({ windowMs: 60_000 } as any);

    const hit1 = await replicaA.store.increment("user-9");
    const hit2 = await replicaB.store.increment("user-9");
    const hit3 = await replicaA.store.increment("user-9");

    expect(hit1.totalHits).toBe(1);
    expect(hit2.totalHits).toBe(2);
    expect(hit3.totalHits).toBe(3);
  });

  it("keeps counters independent per prefix (stacked limiters)", async () => {
    const sharedClient = new FakeRateLimitRedis();
    const api = makeStore({ prefix: "xelma:rl:api/general:", client: sharedClient });
    const write = makeStore({ prefix: "xelma:rl:api/write:", client: sharedClient });

    const apiHit = await api.store.increment("same-ip");
    const writeHit = await write.store.increment("same-ip");

    expect(apiHit.totalHits).toBe(1);
    expect(writeHit.totalHits).toBe(1);
    expect(sharedClient.countFor("xelma:rl:api/general:same-ip")).toBe(1);
    expect(sharedClient.countFor("xelma:rl:api/write:same-ip")).toBe(1);
  });

  it("falls back to a per-process window when Redis is unreachable (fail-open)", async () => {
    const onOutage = jest.fn();
    const store = new RedisRateLimitStore({
      prefix: "xelma:rl:test:",
      // Simulates an outage: the shared client cannot be reached.
      getClient: async () => null,
      onOutage,
    });
    store.init({ windowMs: 60_000 } as any);

    const first = await store.increment("client-1");
    const second = await store.increment("client-1");
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime!.getTime()).toBe(Date.now() + 60_000);
    expect(onOutage).toHaveBeenCalledTimes(2);
  });

  it("opens a fresh fallback window after the window elapses", async () => {
    const store = new RedisRateLimitStore({
      prefix: "xelma:rl:test:",
      getClient: async () => null,
    });
    store.init({ windowMs: 10_000 } as any);

    await store.increment("client-1");
    await store.increment("client-1");
    expect((await store.increment("client-1")).totalHits).toBe(3);

    // Window elapsed → the counter resets and a new window starts.
    jest.advanceTimersByTime(10_001);
    const afterReset = await store.increment("client-1");
    expect(afterReset.totalHits).toBe(1);
    expect(afterReset.resetTime!.getTime()).toBe(Date.now() + 10_000);
  });

  it("throws on outage when configured fail-closed", async () => {
    const onOutage = jest.fn();
    const store = new RedisRateLimitStore({
      prefix: "xelma:rl:test:",
      getClient: async () => null,
      failOpen: false,
      onOutage,
    });
    store.init({ windowMs: 60_000 } as any);

    await expect(store.increment("client-1")).rejects.toThrow(/Redis/);
    expect(onOutage).toHaveBeenCalledTimes(1);
  });

  it("decrement and resetKey reach Redis when available", async () => {
    const { store, client } = makeStore({ prefix: "xelma:rl:test:" });
    store.init({ windowMs: 60_000 } as any);

    await store.increment("client-2");
    await store.increment("client-2");
    await store.decrement("client-2");
    expect(client.countFor("xelma:rl:test:client-2")).toBe(1);

    await store.resetKey("client-2");
    expect(client.countFor("xelma:rl:test:client-2")).toBe(0);
  });

  it("decrement and resetKey fall back locally during an outage", async () => {
    const store = new RedisRateLimitStore({
      prefix: "xelma:rl:test:",
      getClient: async () => null,
    });
    store.init({ windowMs: 60_000 } as any);

    await store.increment("client-3");
    await store.increment("client-3");
    await store.decrement("client-3");
    expect((await store.increment("client-3")).totalHits).toBe(2);

    await store.resetKey("client-3");
    expect((await store.increment("client-3")).totalHits).toBe(1);
  });
});

describe("isRedisRateLimitConfigured", () => {
  const original = process.env.REDIS_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = original;
    }
  });

  it("is false without REDIS_URL (in-process MemoryStore stays in use)", () => {
    delete process.env.REDIS_URL;
    expect(isRedisRateLimitConfigured()).toBe(false);
  });

  it("is true when REDIS_URL is present", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(isRedisRateLimitConfigured()).toBe(true);
  });
});
