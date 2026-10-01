/**
 * WebSocket event contract tests (Issue #650).
 *
 * The existing websocket.service.spec.ts covers emit/replay behavior with a
 * mocked Socket.IO server. What it does not catch is *payload drift*: an event
 * renamed in `WebSocketEvents` but not in the docs, an event name that no
 * longer matches `ServerToClientEvents`, or a money-adjacent payload that
 * starts shipping JSON numbers instead of decimal strings. That drift is what
 * surfaces to players as "the UI just sits there".
 *
 * This suite pins the contract from three angles, all offline:
 *
 *   1. Every event name documented in src/docs/websocket.md exists as a
 *      `WebSocketEvents` constant and as a typed `ServerToClientEvents` key.
 *   2. Every `WebSocketEvents` constant is a typed `ServerToClientEvents` key
 *      (enforced at compile time AND at runtime against a fully enumerated
 *      record, so adding/renaming a type key forces this file to be updated).
 *   3. The money-adjacent events (`bet:accepted`, `round:resolved`,
 *      `round_update`) broadcast payloads that match the documented shapes and
 *      pass `assertNoNumericMoney` — no JSON numbers on money fields.
 *
 * Plus the uninitialized-path safety required by the issue: calling the static
 * emit helpers (and `getIO`) before `initialize()` returns cleanly instead of
 * crashing the process.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Module mocks (same shape as websocket.service.spec.ts)
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

jest.mock("../config", () => ({
  __esModule: true,
  default: { app: { socketDemoMode: false } },
}));

import websocketService, {
  WebSocketService,
  WebSocketEvents,
} from "../services/websocket.service";
import { assertNoNumericMoney } from "../serializers/monetary.serializer";
import type { ServerToClientEvents } from "../types/socket-events";

// ---------------------------------------------------------------------------
// Fully enumerated runtime view of the typed server→client event map.
//
// `Record<keyof ServerToClientEvents, true>` makes the TypeScript compiler
// demand exactly these keys: if an event is added to or renamed in
// `ServerToClientEvents`, this file fails to compile until the map is updated,
// and the runtime assertions below then verify the constants/docs agree.
// ---------------------------------------------------------------------------

const TYPED_SERVER_EVENTS: Record<keyof ServerToClientEvents, true> = {
  "server:hello": true,
  "auth:error": true,
  "room:joined": true,
  "room:left": true,
  "session:resume": true,
  error: true,
  "round:started": true,
  "prediction:placed": true,
  "bet:accepted": true,
  "bet:confirmed": true,
  "bet:resolved": true,
  "bet:failed": true,
  "round:resolved": true,
  "price:update": true,
  price_update: true,
  "chat:message": true,
  "notification:new": true,
  "notification:unread-count": true,
  round_update: true,
};

// Compile-time guard: every WebSocketEvents value must be a typed event key.
type AllWebSocketEventsAreTyped = WebSocketEvents[keyof WebSocketEvents] extends keyof ServerToClientEvents
  ? true
  : false;
const _compileTimeContract: AllWebSocketEventsAreTyped = true;
void _compileTimeContract;

// Connection-lifecycle events that socket.ts emits directly (not via
// WebSocketEvents) and that the docs legitimately mention.
const LIFECYCLE_EVENTS = new Set([
  "server:hello",
  "auth:error",
  "room:joined",
  "room:left",
  "session:resume",
  "session:checkpoint",
  "error",
  "join:round",
  "leave:round",
  "join:chat",
  "leave:chat",
  "chat:send",
  "join:notifications",
]);

/**
 * Parse the server→client event names out of the docs table
 * (`## Server → Client events` in src/docs/websocket.md).
 */
function documentedServerToClientEventNames(): string[] {
  const doc = readFileSync(path.join(__dirname, "../docs/websocket.md"), "utf8");
  const tableStart = doc.lastIndexOf("## Server → Client events");
  expect(tableStart).toBeGreaterThan(-1);

  const names = new Set<string>();
  for (const line of doc.slice(tableStart).split("\n")) {
    if (!line.startsWith("|")) continue;
    // First column of the table row (cells[0] is the empty string before "|").
    const eventCell = line.split("|")[1]?.trim();
    if (!eventCell) continue;
    for (const token of eventCell.match(/`([^`]+)`/g) ?? []) {
      const name = token.slice(1, -1);
      if (/^[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)?$/.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Mocked Socket.IO server plumbing
// ---------------------------------------------------------------------------

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));

/** Pairs of (room, [event, payload]) captured from the fake IO. */
function emitPairs(): Array<[string, [string, any]]> {
  return emit.mock.calls.map((call: any, i: number) => [
    to.mock.calls[i][0],
    call as [string, any],
  ]);
}

const roundFixture = () => ({
  id: "r1",
  mode: "UP_DOWN",
  status: "ACTIVE",
  startTime: new Date("2026-08-01T00:00:00Z"),
  endTime: new Date("2026-08-01T05:00:00Z"),
  startPrice: "1.50000000",
  endPrice: "1.62000000",
  resolvedAt: new Date("2026-08-01T05:00:01Z"),
  priceRanges: null,
  poolUp: "100.00000000",
  poolDown: "200.00000000",
  predictions: [{ won: true }, { won: false }, { won: true }],
});

beforeEach(() => {
  jest.clearAllMocks();
  (websocketService as any).io = null;
});

afterEach(() => {
  (websocketService as any).io = null;
});

// ---------------------------------------------------------------------------
// 1. Docs ↔ constants ↔ types drift guard
// ---------------------------------------------------------------------------

describe("websocket event contract (#650)", () => {
  it("documents stable event-name constants", () => {
    expect(WebSocketEvents).toEqual({
      RoundStarted: "round:started",
      PredictionPlaced: "prediction:placed",
      BetAccepted: "bet:accepted",
      RoundResolved: "round:resolved",
      PriceUpdate: "price:update",
      ChatMessage: "chat:message",
      NotificationNew: "notification:new",
      NotificationUnreadCount: "notification:unread-count",
      RoundUpdate: "round_update",
      PriceUpdateV2: "price_update",
      BetConfirmed: "bet:confirmed",
      BetResolved: "bet:resolved",
      BetFailed: "bet:failed",
    });
  });

  it("every documented server→client event exists as a constant and a typed key", () => {
    const documented = documentedServerToClientEventNames();
    // The docs table must keep listing the realtime events.
    expect(documented).toEqual(
      expect.arrayContaining([
        "round:started",
        "round_update",
        "prediction:placed",
        "bet:accepted",
        "price:update",
        "price_update",
        "round:resolved",
        "chat:message",
        "notification:new",
      ]),
    );

    const constants = new Set(Object.values(WebSocketEvents));
    const typedKeys = new Set(Object.keys(TYPED_SERVER_EVENTS));
    for (const name of documented) {
      expect(constants.has(name) || LIFECYCLE_EVENTS.has(name)).toBe(true);
      expect(typedKeys.has(name)).toBe(true);
    }
  });

  it("every WebSocketEvents constant is a typed ServerToClientEvents key", () => {
    for (const [constant, eventName] of Object.entries(WebSocketEvents)) {
      expect(TYPED_SERVER_EVENTS).toHaveProperty(eventName as string);
      void constant;
    }
  });

  it("every emit method uses the constant, not a drifted string literal", () => {
    websocketService.initialize({ to } as any);

    websocketService.emitPredictionPlaced(
      { id: "p1", amount: "5", side: "UP", priceRange: "2.00" },
      "r1",
    );
    websocketService.emitRoundResolved(roundFixture());
    websocketService.emitNotification("user-1", {
      id: "n1",
      type: "WIN",
      data: null,
      isRead: false,
    });
    websocketService.emitUnreadCountUpdate("user-1", 2);

    const events = emitPairs().map(([, [event]]) => event);
    expect(events).toContain(WebSocketEvents.PredictionPlaced);
    expect(events).toContain(WebSocketEvents.RoundResolved);
    expect(events).toContain(WebSocketEvents.RoundUpdate);
    expect(events).toContain(WebSocketEvents.NotificationNew);
    expect(events).toContain(WebSocketEvents.NotificationUnreadCount);
    // Constants and emitted names never diverge.
    for (const event of events) {
      expect(Object.values(WebSocketEvents)).toContain(event);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Money-adjacent payload shapes
// ---------------------------------------------------------------------------

describe("money-adjacent event payloads (#650)", () => {
  beforeEach(() => {
    websocketService.initialize({ to } as any);
  });

  it("bet:accepted carries exactly the documented BetAcceptedPayload fields", () => {
    websocketService.emitBetAccepted({
      roundId: "r1",
      address: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      amount: "25.00000000",
      side: "UP",
      mode: "UP_DOWN",
      state: "stub",
    });

    const [, [event, payload]] = emitPairs()[0];
    expect(event).toBe(WebSocketEvents.BetAccepted);

    // Keys must stay within the documented payload shape
    // (BetAcceptedPayload in src/types/socket-events.ts / websocket.md).
    expect(Object.keys(payload).sort()).toEqual([
      "address",
      "amount",
      "mode",
      "roundId",
      "side",
      "state",
    ]);
    // Required fields always present; optionals only when known.
    for (const required of ["address", "amount", "mode", "state"]) {
      expect(payload).toHaveProperty(required);
    }
    expect(payload).toMatchObject({
      roundId: "r1",
      side: "UP",
      mode: "UP_DOWN",
      state: "stub",
    });
    // Money-adjacent: amount is a decimal string, never a JSON number.
    expect(typeof payload.amount).toBe("string");
    expect(() => assertNoNumericMoney(payload)).not.toThrow();
  });

  it("round:resolved carries exactly the documented RoundResolvedPayload shape", () => {
    websocketService.emitRoundResolved(roundFixture());

    const [, [event, payload]] = emitPairs()[0];
    expect(event).toBe(WebSocketEvents.RoundResolved);
    expect(Object.keys(payload).sort()).toEqual([
      "endPrice",
      "id",
      "predictions",
      "resolvedAt",
      "startPrice",
      "status",
      "winners",
    ]);
    expect(payload).toMatchObject({
      id: "r1",
      status: "ACTIVE",
      predictions: 3,
      winners: 2,
      startPrice: "1.50000000",
      endPrice: "1.62000000",
    });
    // Counts are numbers; prices are decimal strings.
    expect(typeof payload.predictions).toBe("number");
    expect(typeof payload.winners).toBe("number");
    expect(typeof payload.startPrice).toBe("string");
    expect(typeof payload.endPrice).toBe("string");
    expect(() => assertNoNumericMoney(payload)).not.toThrow();
  });

  it("round_update payloads on both rooms pass the no-numeric-money contract", () => {
    websocketService.emitRoundUpdate(roundFixture());

    const updates = emitPairs().filter(([, [event]]) => event === WebSocketEvents.RoundUpdate);
    expect(updates.map(([room]) => room)).toEqual(["round", "round:r1"]);
    for (const [, [, payload]] of updates) {
      expect(Object.keys(payload).sort()).toEqual([
        "endPrice",
        "endTime",
        "id",
        "mode",
        "poolDown",
        "poolUp",
        "priceRanges",
        "resolvedAt",
        "startPrice",
        "startTime",
        "status",
      ]);
      expect(typeof payload.poolUp).toBe("string");
      expect(typeof payload.poolDown).toBe("string");
      expect(() => assertNoNumericMoney(payload)).not.toThrow();
    }
  });

  it("successful emits never touch the DLQ", () => {
    websocketService.emitBetAccepted({
      address: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      amount: "10",
      mode: "PRECISION",
      state: "accepted",
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Uninitialized static helpers / getIO must not crash the process
// ---------------------------------------------------------------------------

describe("uninitialized service safety (static helpers)", () => {
  it("static emitRoundUpdate before initialize() does not throw", () => {
    expect(() => WebSocketService.emitRoundUpdate(roundFixture())).not.toThrow();
    expect(mockRecord).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("static emitPriceUpdate before initialize() does not throw", async () => {
    await expect(
      Promise.resolve(WebSocketService.emitPriceUpdate({ asset: "XLM", price: "0.42" })),
    ).resolves.toBeUndefined();
    expect(mockRecord).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("getIO() returns null before initialize() and the fake IO after", () => {
    expect(WebSocketService.instance.getIO()).toBeNull();
    websocketService.initialize({ to } as any);
    expect(WebSocketService.instance.getIO()).toEqual({ to });
  });
});
