/**
 * bet:accepted delivery (#376).
 *
 * BetService no longer emits over the socket itself. It writes a BET_ACCEPTED
 * row to the outbox inside the same transaction as the bet, and the scheduler's
 * outbox dispatcher turns that row into `websocketService.emitBetAccepted`.
 * Splitting the write from the emit is what makes the event survive a crash
 * between the two, so both halves are covered here:
 *
 *   1. BetService writes exactly one BET_ACCEPTED row carrying the bet's real
 *      state (stub vs on-chain) — and writes none when placement fails.
 *   2. Feeding that payload to the emit path broadcasts `bet:accepted` to the
 *      `round` room and to `round:{roundId}` when the round is known.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
  },
}));

jest.mock("../services/bet-audit.service", () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitBetFailed: jest.fn(),
    emitBetReconciled: jest.fn(),
  },
}));

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const emitMock = jest.fn();
const toMock = jest.fn(() => ({ emit: emitMock }));

const outboxCreate = jest.fn();
const roundFindFirst = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findMany: jest.fn<any>().mockResolvedValue([]),
      findFirst: (...args: unknown[]) => roundFindFirst(...args),
    },
    $transaction: (fn: any) => {
      let lastCreatedBet: any = null;
      return fn({
        user: {
          findUnique: jest.fn<any>().mockResolvedValue({ id: "u1" }),
          create: jest.fn<any>().mockResolvedValue({ id: "u1" }),
        },
        round: {
          findUnique: jest.fn<any>().mockResolvedValue(null),
          findFirst: (...args: unknown[]) => roundFindFirst(...args),
        },
        bet: {
          create: (args: any) => {
            lastCreatedBet = {
              id: "bet-1",
              ...args.data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            return Promise.resolve(lastCreatedBet);
          },
          findUnique: jest.fn(() => Promise.resolve(lastCreatedBet)),
          update: jest.fn((args: any) => Promise.resolve(args.data)),
        },
        outboxEvent: {
          create: (args: any) => {
            outboxCreate(args);
            return Promise.resolve({ id: "outbox-1" });
          },
        },
      });
    },
  },
}));

jest.mock("../services/dead-letter-queue.service", () => ({
  __esModule: true,
  default: { record: jest.fn() },
}));

jest.mock("../metrics/application.metrics", () => ({
  websocketEmitsTotal: { inc: jest.fn() },
}));

import betService from "../services/bet.service";
import sorobanService from "../services/soroban.service";
import websocketService, {
  WebSocketEvents,
} from "../services/websocket.service";

const VALID_ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

/** The BET_ACCEPTED rows BetService wrote during the current test. */
const betAcceptedPayloads = () =>
  outboxCreate.mock.calls
    .map(([args]: any[]) => args.data)
    .filter((data: any) => data.eventType === "BET_ACCEPTED")
    .map((data: any) => data.payload);

describe("bet:accepted delivery (#376)", () => {
  const originalStub = process.env.BET_STUB_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    emitMock.mockClear();
    toMock.mockClear();
    roundFindFirst.mockResolvedValue({ id: "btc-updown-live" });
    websocketService.initialize({ to: toMock } as any);
  });

  afterEach(() => {
    if (originalStub === undefined) {
      delete process.env.BET_STUB_MODE;
    } else {
      process.env.BET_STUB_MODE = originalStub;
    }
    (websocketService as any).io = null;
  });

  it("defines a stable bet:accepted event name", () => {
    expect(WebSocketEvents.BetAccepted).toBe("bet:accepted");
  });

  describe("BetService writes the outbox row", () => {
    it("queues a stub BET_ACCEPTED event for an UP/DOWN bet", async () => {
      process.env.BET_STUB_MODE = "true";

      await betService.recordUpDownBet({
        address: VALID_ADDRESS,
        amount: 25,
        side: "UP",
      });

      expect(betAcceptedPayloads()).toEqual([
        expect.objectContaining({
          betId: "bet-1",
          roundId: "btc-updown-live",
          mode: "UP_DOWN",
          side: "UP",
          amount: 25,
          state: "stub",
        }),
      ]);
    });

    it("queues an on-chain BET_ACCEPTED event carrying the tx hash", async () => {
      process.env.BET_STUB_MODE = "false";
      roundFindFirst.mockResolvedValue({ id: "eth-precision-live" });
      (sorobanService.placePrecisionBet as jest.Mock<any>).mockResolvedValue({
        state: "on-chain-success",
        txHash: "0xdeadbeef",
      });

      await betService.recordPrecisionBet({
        address: VALID_ADDRESS,
        amount: 10,
        predictedPrice: 0.3,
      });

      expect(betAcceptedPayloads()).toEqual([
        expect.objectContaining({
          roundId: "eth-precision-live",
          mode: "PRECISION",
          amount: 10,
          predictedPrice: 0.3,
          state: "accepted",
          txHash: "0xdeadbeef",
        }),
      ]);
    });

    it("queues BET_FAILED and no BET_ACCEPTED when on-chain placement fails", async () => {
      process.env.BET_STUB_MODE = "false";
      (sorobanService.placeBet as jest.Mock<any>).mockRejectedValue(
        new Error("rpc unavailable"),
      );

      await expect(
        betService.recordUpDownBet({
          address: VALID_ADDRESS,
          amount: 5,
          side: "DOWN",
        }),
      ).rejects.toThrow("rpc unavailable");

      expect(betAcceptedPayloads()).toEqual([]);

      const eventTypes = outboxCreate.mock.calls.map(
        ([args]: any[]) => args.data.eventType,
      );
      expect(eventTypes).toEqual(["BET_FAILED"]);
    });
  });

  describe("dispatching the outbox row emits bet:accepted", () => {
    it("broadcasts to the round room and the round-specific room", () => {
      websocketService.emitBetAccepted({
        roundId: "btc-updown-live",
        address: VALID_ADDRESS,
        amount: "25",
        side: "UP",
        mode: "UP_DOWN",
        state: "stub",
      });

      expect(toMock).toHaveBeenCalledWith("round");
      expect(toMock).toHaveBeenCalledWith("round:btc-updown-live");
      expect(emitMock).toHaveBeenCalledWith(
        "bet:accepted",
        expect.objectContaining({
          address: VALID_ADDRESS,
          amount: "25",
          side: "UP",
          mode: "UP_DOWN",
          state: "stub",
          roundId: "btc-updown-live",
        }),
      );
    });

    it("broadcasts only to the round room when no round is bound", () => {
      websocketService.emitBetAccepted({
        address: VALID_ADDRESS,
        amount: "10",
        mode: "PRECISION",
        state: "accepted",
        txHash: "0xdeadbeef",
      });

      expect(toMock).toHaveBeenCalledTimes(1);
      expect(toMock).toHaveBeenCalledWith("round");
      expect(emitMock).toHaveBeenCalledWith(
        "bet:accepted",
        expect.objectContaining({ txHash: "0xdeadbeef", state: "accepted" }),
      );
    });
  });
});
