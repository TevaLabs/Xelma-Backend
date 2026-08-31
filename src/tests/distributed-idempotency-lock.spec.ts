import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { getConnectedRedisClient } from "../lib/redis";
import {
  buildDistributedIdempotencyLockKey,
  DistributedIdempotencyLockUnavailableError,
  withDistributedIdempotencyLock,
} from "../utils/distributed-idempotency-lock";
import { ErrorCode } from "../utils/errors";

jest.mock("../lib/redis", () => ({
  getConnectedRedisClient: jest.fn(),
}));

const mockGetConnectedRedisClient = getConnectedRedisClient as jest.Mock;

function makeFakeClient() {
  return {
    set: jest.fn(),
    eval: jest.fn(),
  };
}

describe("distributed idempotency lock (fail-closed)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds a lock key scoped to user + endpoint + idempotency key", () => {
    expect(
      buildDistributedIdempotencyLockKey(
        "user-1",
        "/api/bets/up-down",
        "key-123",
      ),
    ).toBe("xelma:idempotency-lock:user-1:/api/bets/up-down:key-123");
  });

  it("acquires with SET NX EX, runs the callback, and releases with an owner check", async () => {
    const client = makeFakeClient();
    client.set.mockResolvedValue("OK");
    client.eval.mockResolvedValue(1);
    mockGetConnectedRedisClient.mockResolvedValue(client);

    let ran = false;
    await withDistributedIdempotencyLock(
      "user-1",
      "/api/bets/up-down",
      "key-123",
      async () => {
        ran = true;
      },
    );

    expect(ran).toBe(true);
    expect(client.set).toHaveBeenCalledWith(
      "xelma:idempotency-lock:user-1:/api/bets/up-down:key-123",
      expect.any(String),
      { NX: true, EX: 30 },
    );
    expect(client.eval).toHaveBeenCalledTimes(1);
    const [, evalArgs] = client.eval.mock.calls[0];
    expect(evalArgs).toHaveProperty("keys", [
      "xelma:idempotency-lock:user-1:/api/bets/up-down:key-123",
    ]);
  });

  it("fails closed when Redis is unreachable (client resolves to null)", async () => {
    mockGetConnectedRedisClient.mockResolvedValue(null);

    let ran = false;
    await expect(
      withDistributedIdempotencyLock(
        "user-1",
        "/api/bets/up-down",
        "key-123",
        async () => {
          ran = true;
        },
      ),
    ).rejects.toBeInstanceOf(DistributedIdempotencyLockUnavailableError);

    expect(ran).toBe(false);
  });

  it("fails closed when the SET command throws (Redis went down mid-flight)", async () => {
    const client = makeFakeClient();
    client.set.mockRejectedValue(new Error("connection refused"));
    mockGetConnectedRedisClient.mockResolvedValue(client);

    let ran = false;
    await expect(
      withDistributedIdempotencyLock(
        "user-1",
        "/api/bets/up-down",
        "key-123",
        async () => {
          ran = true;
        },
      ),
    ).rejects.toBeInstanceOf(DistributedIdempotencyLockUnavailableError);

    expect(ran).toBe(false);
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it("waits and retries while another replica holds the lock, then proceeds", async () => {
    const client = makeFakeClient();
    // First attempt: held by another replica. Second attempt: acquired.
    client.set.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    client.eval.mockResolvedValue(1);
    mockGetConnectedRedisClient.mockResolvedValue(client);

    let ran = false;
    await withDistributedIdempotencyLock(
      "user-1",
      "/api/bets/up-down",
      "key-123",
      async () => {
        ran = true;
      },
      { retryDelayMs: 5, acquireTimeoutMs: 1000 },
    );

    expect(ran).toBe(true);
    expect(client.set).toHaveBeenCalledTimes(2);
  });

  it("rejects with a conflict (never runs the callback) when the lock stays held", async () => {
    const client = makeFakeClient();
    client.set.mockResolvedValue(null);
    mockGetConnectedRedisClient.mockResolvedValue(client);

    let ran = false;
    await expect(
      withDistributedIdempotencyLock(
        "user-1",
        "/api/bets/up-down",
        "key-123",
        async () => {
          ran = true;
        },
        { retryDelayMs: 5, acquireTimeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
    });

    expect(ran).toBe(false);
  });

  it("releases the lock even when the callback throws", async () => {
    const client = makeFakeClient();
    client.set.mockResolvedValue("OK");
    client.eval.mockResolvedValue(1);
    mockGetConnectedRedisClient.mockResolvedValue(client);

    await expect(
      withDistributedIdempotencyLock(
        "user-1",
        "/api/bets/up-down",
        "key-123",
        async () => {
          throw new Error("processing failed");
        },
      ),
    ).rejects.toThrow("processing failed");

    expect(client.eval).toHaveBeenCalledTimes(1);
  });
});
