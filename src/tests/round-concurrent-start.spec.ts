import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { RoundService } from "../services/round.service";
import { prisma } from "../lib/prisma";
import { ConflictError, ErrorCode } from "../utils/errors";
import * as distributedLockModule from "../utils/distributed-lock";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    createRound: jest.fn().mockResolvedValue(undefined as never),
    applyMoneyPathFailure: jest.fn(),
    isReady: jest.fn().mockReturnValue(false),
  },
}));

jest.mock("../services/websocket.service", () => ({
  __esModule: true,
  default: {
    emitRoundStarted: jest.fn(),
    emitNotification: jest.fn(),
  },
}));

jest.mock("../services/notification.service", () => ({
  __esModule: true,
  default: {
    createNotification: jest.fn().mockResolvedValue(null as never),
  },
}));

jest.mock("../lib/prisma", () => ({
  prisma: {
    $transaction: jest.fn(),
    user: {
      findMany: jest.fn().mockResolvedValue([] as never),
    },
  },
}));

describe("RoundService - Concurrent start race prevention (Transactional check + distributed lock)", () => {
  let roundService: RoundService;

  beforeEach(() => {
    jest.clearAllMocks();
    roundService = new RoundService();
  });

  it("successfully starts a round when no active round exists within transaction", async () => {
    const mockRound = {
      id: "round-123",
      mode: "UP_DOWN",
      status: "ACTIVE",
      startTime: new Date(),
      endTime: new Date(),
      startPrice: 100,
      sorobanRoundId: null,
      isSoroban: false,
      priceRanges: null,
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      const tx = {
        round: {
          findFirst: jest.fn().mockResolvedValue(null as never),
          create: jest.fn().mockResolvedValue(mockRound as never),
        },
      };
      return callback(tx);
    });

    const result = await roundService.startRound("UP_DOWN", 100, 5);

    expect(result).toEqual(mockRound);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("throws 409 ConflictError (ACTIVE_ROUND_EXISTS) when an active round is found inside transaction", async () => {
    const existingRound = {
      id: "round-existing",
      mode: "UP_DOWN",
      status: "ACTIVE",
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      const tx = {
        round: {
          findFirst: jest.fn().mockResolvedValue(existingRound as never),
          create: jest.fn(),
        },
      };
      return callback(tx);
    });

    await expect(
      roundService.startRound("UP_DOWN", 100, 5),
    ).rejects.toThrow(ConflictError);

    try {
      await roundService.startRound("UP_DOWN", 100, 5);
    } catch (error: any) {
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe(ErrorCode.ACTIVE_ROUND_EXISTS);
      expect(error.message).toContain("An active UP_DOWN round already exists");
    }
  });

  it("throws 409 ConflictError when distributed lock cannot be acquired due to concurrent start", async () => {
    const spy = jest
      .spyOn(distributedLockModule, "withDistributedLockOrConflict")
      .mockRejectedValueOnce(
        new ConflictError(
          "An active UP_DOWN round already exists",
          ErrorCode.ACTIVE_ROUND_EXISTS,
        ),
      );

    await expect(
      roundService.startRound("UP_DOWN", 100, 5),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.ACTIVE_ROUND_EXISTS,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("withDistributedLockOrConflict helper", () => {
  it("throws 409 ConflictError when lock acquisition returns acquired: false", async () => {
    jest.spyOn(distributedLockModule.DistributedLock.prototype, "acquire").mockResolvedValueOnce({
      acquired: false,
    });

    await expect(
      distributedLockModule.withDistributedLockOrConflict(
        "test-lock",
        async () => "ok",
        "Conflict occurred",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.ACTIVE_ROUND_EXISTS,
      message: "Conflict occurred",
    });
  });

  it("throws 409 ConflictError when lock is lost during execution", async () => {
    jest.spyOn(distributedLockModule.DistributedLock.prototype, "acquire").mockResolvedValueOnce({
      acquired: true,
      lockId: "test-id",
    });
    jest.spyOn(distributedLockModule.DistributedLock.prototype, "release").mockResolvedValueOnce();

    await expect(
      distributedLockModule.withDistributedLockOrConflict(
        "test-lock",
        async (lock) => {
          throw new distributedLockModule.LockLostError(lock.lockName, "stolen");
        },
        "Conflict occurred",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCode.ACTIVE_ROUND_EXISTS,
      message: "Conflict occurred",
    });
  });
});
