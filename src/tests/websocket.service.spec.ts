/**
 * Unit tests for src/services/websocket.service.ts emit paths and
 * uninitialized replay error handling (Issue #528).
 *
 * Coverage intent:
 *   - Every public emit method broadcasts on the expected room with the exact
 *     event name and shaped payload (asserted via a mocked Socket.IO server).
 *   - Emitting before `initialize()` is safe: it never throws, warns instead,
 *     increments an `unavailable` outcome metric, and records a DLQ row so the
 *     event can be replayed once sockets are up.
 *   - `replayEmit` fails fast on the DLQ-retry path: it throws when the socket
 *     layer is uninitialized, when the event name is missing, and when the room
 *     is missing — so the DLQ bumps its attempt counter instead of falsely
 *     resolving the row. When fully initialized it re-emits correctly.
 *   - The price-update fan-out covers both the DB-backed active-round path and
 *     the Prisma-less demo-mode adapter-room path.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockRecord: any = jest.fn();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as any;
  return {
    ...actual,
    DispatchChannel: {
      NOTIFICATION_CREATE: "NOTIFICATION_CREATE",
      WEBSOCKET_EMIT: "WEBSOCKET_EMIT",
    },
  };
});

jest.mock("../lib/prisma", () => ({
  prisma: {
    round: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock("../services/dead-letter-queue.service", () => ({
  __esModule: true,
  default: { record: (...args: any[]) => mockRecord(...args) },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../metrics/application.metrics", () => ({
  websocketEmitsTotal: { inc: jest.fn() },
}));

// Mutable config object so individual tests can flip socketDemoMode.
jest.mock("../config", () => ({
  __esModule: true,
  default: { app: { socketDemoMode: false } },
}));

import websocketService, {
  WebSocketEvents,
} from "../services/websocket.service";
import { prisma } from "../lib/prisma";
import { websocketEmitsTotal } from "../metrics/application.metrics";
import config from "../config";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Test double for the Socket.IO server
// ---------------------------------------------------------------------------

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
const adapterRooms = new Map<string, Set<string>>();
const of = jest.fn(() => ({ adapter: { rooms: adapterRooms } }));
const fakeIo: any = { to, of };

/** Reset the service + all mocks to a clean, uninitialized state. */
function resetService(): void {
  (websocketService as any).io = null;
}

/** Initialize the singleton with the shared fake IO. */
function initService(): void {
  websocketService.initialize(fakeIo);
}

/** Pairs of (room, [event, payload]) captured from the fake IO. */
function emitPairs(): Array<[string, [string, unknown]]> {
  return emit.mock.calls.map((call: any, i: number) => [
    to.mock.calls[i][0],
    call as unknown as [string, unknown],
  ]);
}

const roundFixture = () => ({
  id: "r1",
  mode: "UP_DOWN",
  status: "ACTIVE",
  startTime: new Date("2026-08-01T00:00:00Z"),
  endTime: new Date("2026-08-01T05:00:00Z"),
  startPrice: "1.50000000",
  priceRanges: null,
  poolUp: "100.00000000",
  poolDown: "200.00000000",
});

beforeEach(() => {
  jest.clearAllMocks();
  emit.mockClear();
  to.mockClear();
  of.mockClear();
  adapterRooms.clear();
  resetService();
  (config as any).app.socketDemoMode = false;
});

afterEach(() => {
  resetService();
});

// ---------------------------------------------------------------------------
// Uninitialized emit safety (Issue #193 behavior, covered rather than
// regressed here)
// ---------------------------------------------------------------------------

describe.each([
  ["emitRoundStarted", (s: any) => s.emitRoundStarted(roundFixture())],
  ["emitPredictionPlaced", (s: any) => s.emitPredictionPlaced({ id: "p1", amount: "5", side: "UP", priceRange: "2.00" }, "r1")],
  ["emitBetAccepted", (s: any) => s.emitBetAccepted({ address: "addr", amount: "5", mode: "UP_DOWN", state: "stub" })],
  ["emitRoundResolved", (s: any) => s.emitRoundResolved({ ...roundFixture(), resolvedAt: new Date(), predictions: [], endPrice: "2.00" })],
  ["emitRoundUpdate", (s: any) => s.emitRoundUpdate(roundFixture())],
  ["emitPriceUpdate", (s: any) => s.emitPriceUpdate("XLM", "0.42")],
  ["emitChatMessage", (s: any) => s.emitChatMessage({ id: "m1", content: "hi" })],
  ["emitNotification", (s: any) => s.emitNotification("user-1", { id: "n1", type: "WIN", data: null, isRead: false })],
  ["emitUnreadCountUpdate", (s: any) => s.emitUnreadCountUpdate("user-1", 3)],
])("safe behavior when uninitialized: %s", (_name, doEmit) => {
  it("does not throw and records a DLQ row with an unavailable outcome", () => {
    expect(() => doEmit(websocketService)).not.toThrow();
    expect(mockRecord).toHaveBeenCalled();
    const args: any = mockRecord.mock.calls[0][0];
    expect(args.channel).toBe("WEBSOCKET_EMIT");
    expect(args.error).toEqual(expect.any(Error));
    expect(websocketEmitsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unavailable" }),
    );
    expect(logger.warn).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not throw, even though the callback returns synchronously (fire-and-forget)", () => {
    expect(() => doEmit(websocketService)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Emit payload assertions (initialized)
// ---------------------------------------------------------------------------

describe("emitRoundStarted", () => {
  it("broadcasts round:started to the round room, then round_update to both rooms", () => {
    initService();
    websocketService.emitRoundStarted(roundFixture());

    const pairs = emitPairs();
    // 1) round:started
    expect(pairs[0][0]).toBe("round");
    expect(pairs[0][1][0]).toBe(WebSocketEvents.RoundStarted);
    expect(pairs[0][1][1]).toMatchObject({
      id: "r1",
      mode: "UP_DOWN",
      status: "ACTIVE",
      startPrice: "1.50000000",
    });
    // 2) + 3) round_update to 'round' and 'round:r1'
    expect(pairs.filter(([, call]) => call[0] === "round_update")).toHaveLength(2);
    expect(pairs.map(([room]) => room)).toEqual([
      "round",
      "round",
      "round:r1",
    ]);
  });
});

describe("emitPredictionPlaced", () => {
  it("broadcasts prediction:placed with the shaped payload", () => {
    initService();
    websocketService.emitPredictionPlaced(
      { id: "p1", amount: "5.00000000", side: "UP", priceRange: "2.00000000" },
      "r1",
    );
    const [room, [event, payload]] = emitPairs()[0];
    expect(room).toBe("round");
    expect(event).toBe(WebSocketEvents.PredictionPlaced);
    expect(payload).toMatchObject({
      roundId: "r1",
      predictionId: "p1",
      amount: "5.00000000",
      side: "UP",
      priceRange: "2.00000000",
    });
  });
});

describe("emitBetAccepted", () => {
  it("broadcasts bet:accepted to the round room and the round-specific room", () => {
    initService();
    websocketService.emitBetAccepted({
      roundId: "r1",
      address: "addr",
      amount: "25",
      side: "UP",
      mode: "UP_DOWN",
      state: "stub",
    });

    const pairs = emitPairs();
    expect(pairs.map(([room]) => room)).toEqual(["round", "round:r1"]);
    for (const [, [event, payload]] of pairs) {
      expect(event).toBe(WebSocketEvents.BetAccepted);
      expect(payload).toMatchObject({ roundId: "r1", address: "addr", state: "stub" });
    }
  });

  it("broadcasts only to the round room when no round is bound", () => {
    initService();
    websocketService.emitBetAccepted({
      address: "addr",
      amount: "10",
      mode: "PRECISION",
      state: "accepted",
      txHash: "0xdeadbeef",
    });
    const pairs = emitPairs();
    expect(pairs.map(([room]) => room)).toEqual(["round"]);
    expect(pairs[0][1][1]).toMatchObject({ txHash: "0xdeadbeef", mode: "PRECISION" });
  });
});

describe("emitRoundResolved", () => {
  it("broadcasts round:resolved with win/prediction counts, then round_update", () => {
    initService();
    websocketService.emitRoundResolved({
      ...roundFixture(),
      resolvedAt: new Date("2026-08-01T06:00:00Z"),
      endPrice: "2.00000000",
      predictions: [
        { won: true },
        { won: false },
        { won: true },
        { won: null },
      ],
    });

    const pairs = emitPairs();
    expect(pairs[0][0]).toBe("round");
    expect(pairs[0][1][0]).toBe(WebSocketEvents.RoundResolved);
    expect(pairs[0][1][1]).toMatchObject({
      id: "r1",
      status: "ACTIVE",
      predictions: 4,
      winners: 2,
      endPrice: "2.00000000",
    });
    // round_update driven in addition
    expect(pairs.filter(([, call]) => call[0] === "round_update")).toHaveLength(2);
  });
});

describe("emitRoundUpdate", () => {
  it("broadcasts a serialized round_update payload to general + round rooms", () => {
    initService();
    websocketService.emitRoundUpdate(roundFixture());

    const pairs = emitPairs();
    expect(pairs.map(([room]) => room)).toEqual(["round", "round:r1"]);
    for (const [, [event, payload]] of pairs) {
      expect(event).toBe("round_update");
      expect(payload).toMatchObject({
        id: "r1",
        mode: "UP_DOWN",
        status: "ACTIVE",
        startPrice: "1.50000000",
        poolUp: "100.00000000",
        poolDown: "200.00000000",
        priceRanges: null,
      });
      // monetary fields are decimal strings, never JSON numbers
      expect(typeof payload.startPrice).toBe("string");
      expect(typeof payload.poolUp).toBe("string");
    }
  });
});

describe("emitPriceUpdate", () => {
  it("broadcasts price:update and price_update to the round room (DB path)", async () => {
    initService();
    (prisma.round.findMany as jest.Mock<any>).mockResolvedValue([
      { id: "active-1" },
      { id: "active-2" },
    ]);

    await websocketService.emitPriceUpdate("XLM", "0.42");

    const pairs = emitPairs();
    expect(to).toHaveBeenCalledWith("round");
    expect(to).toHaveBeenCalledWith("round:active-1");
    expect(to).toHaveBeenCalledWith("round:active-2");

    const events = pairs.map(([, [e]]) => e);
    expect(events).toContain("price:update");
    expect(events).toContain("price_update");
    for (const [, [e, payload]] of pairs) {
      expect(payload).toMatchObject({ asset: "XLM", price: "0.42" });
      expect(typeof payload.timestamp).toBe("string");
      void e;
    }
  });

  it("does not emit to round-specific rooms when there are no active rounds", async () => {
    initService();
    (prisma.round.findMany as jest.Mock<any>).mockResolvedValue([]);
    await websocketService.emitPriceUpdate("XLM", "0.42");
    // Two general-room emits only.
    for (const [room] of emitPairs()) {
      expect(room).toBe("round");
    }
    expect(to).toHaveBeenCalledTimes(2);
  });

  it("fans out to every round: adapter room in demo mode without Prisma", async () => {
    (config as any).app.socketDemoMode = true;
    initService();
    adapterRooms.set("round:demo-1", new Set(["s1"]));
    adapterRooms.set("round:demo-2", new Set(["s2"]));
    adapterRooms.set("chat", new Set(["s3"])); // non-round room ignored

    await websocketService.emitPriceUpdate("BTC", 70000);

    expect(to).toHaveBeenCalledWith("round");
    expect(to).toHaveBeenCalledWith("round:demo-1");
    expect(to).toHaveBeenCalledWith("round:demo-2");
    expect(to).not.toHaveBeenCalledWith("chat");
    // Demo mode never touches the DB.
    expect(prisma.round.findMany).not.toHaveBeenCalled();
  });
});

describe("emitChatMessage", () => {
  it("broadcasts chat:message to the chat room", () => {
    initService();
    websocketService.emitChatMessage({ id: "m1", content: "hello" });
    const [room, [event, payload]] = emitPairs()[0];
    expect(room).toBe("chat");
    expect(event).toBe(WebSocketEvents.ChatMessage);
    expect(payload).toMatchObject({ id: "m1", content: "hello" });
  });
});

describe("emitNotification", () => {
  it("broadcasts notification:new to the user room with the shaped payload", () => {
    initService();
    websocketService.emitNotification(
      "user-1",
      {
        id: "n1",
        type: "WIN",
        title: "You won!",
        message: "+100 XLM",
        data: { amount: "100" },
        isRead: false,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    );
    const [room, [event, payload]] = emitPairs()[0];
    expect(room).toBe("user:user-1");
    expect(event).toBe(WebSocketEvents.NotificationNew);
    expect(payload).toMatchObject({
      id: "n1",
      type: "WIN",
      title: "You won!",
      isRead: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      data: { amount: "100" },
    });
  });
});

describe("emitUnreadCountUpdate", () => {
  it("broadcasts notification:unread-count to the user room with the count", () => {
    initService();
    websocketService.emitUnreadCountUpdate("user-1", 3);
    const [room, [event, payload]] = emitPairs()[0];
    expect(room).toBe("user:user-1");
    expect(event).toBe(WebSocketEvents.NotificationUnreadCount);
    expect(payload).toMatchObject({ unreadCount: 3 });
    expect(typeof payload.timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Failure path: underlying io.emit throws → caught + DLQ + failure metric
// ---------------------------------------------------------------------------

describe("underlying emit throws", () => {
  it("does not propagate the error and records a DLQ entry with a failure outcome", () => {
    const throwingEmit = jest.fn(() => {
      throw new Error("socket crash");
    });
    const fakeIoThrowing: any = { to: jest.fn(() => ({ emit: throwingEmit })) };
    websocketService.initialize(fakeIoThrowing);

    expect(() => websocketService.emitChatMessage({ id: "m1" })).not.toThrow();
    expect(throwingEmit).toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalled();
    expect(websocketEmitsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat:message", outcome: "failure" }),
    );
  });
});

// ---------------------------------------------------------------------------
// replayEmit — the DLQ retry handler
// ---------------------------------------------------------------------------

describe("replayEmit", () => {
  it("throws when sockets are not initialized so the DLQ retries", () => {
    resetService();
    expect(() =>
      websocketService.replayEmit("notification:new", { room: "user:u1", data: {} }),
    ).toThrow(/not initialized/i);
  });

  it("throws when the event name is missing", () => {
    initService();
    expect(() =>
      websocketService.replayEmit(null, { room: "user:u1", data: {} }),
    ).toThrow(/missing eventName/i);
  });

  it("throws when the room is missing", () => {
    initService();
    expect(() =>
      websocketService.replayEmit("notification:new", { data: {} }),
    ).toThrow(/missing room/i);
  });

  it("re-emits the stored payload to the stored room when initialized", () => {
    initService();
    websocketService.replayEmit("notification:new", {
      room: "user:u1",
      data: { id: "n1" },
    });
    expect(to).toHaveBeenCalledWith("user:u1");
    expect(emit).toHaveBeenCalledWith("notification:new", { id: "n1" });
  });

  it("restores full replay flow after a not-initialized throw (recovery)", () => {
    resetService();
    expect(() =>
      websocketService.replayEmit("notification:new", { room: "user:u1", data: { id: "x" } }),
    ).toThrow();

    initService();
    websocketService.replayEmit("notification:new", { room: "user:u1", data: { id: "x" } });
    expect(emit).toHaveBeenCalledWith("notification:new", { id: "x" });
  });
});