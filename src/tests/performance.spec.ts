import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import request from "supertest";
import { createServer, Server as HttpServer } from "http";
import { io as ioClient, Socket } from "socket.io-client";
import { Express } from "express";
import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";
import { initializeSocket } from "../socket";
import websocketService, { WebSocketEvents } from "../services/websocket.service";
import {
  formatFanoutReport,
  formatLoadTestReport,
  getLoadTestConfig,
  measureWebSocketFanout,
  runConcurrentLoad,
} from "./load-test.harness";
import { betStore } from "../data/bet-store";

// #519: the bet-store facade defaults to the postgres backend whenever
// DATA_MODE is unset, which would route every bet through the mocked prisma
// (no betRecord model) and 500 the load tests. This suite is explicitly
// DB-free, so pin the in-memory backend for the whole file.
process.env.DATA_STORE = "memory";

// Mock external services to keep performance tests focused on backend logic
jest.mock("../services/stellar.service", () => ({
  verifySignature: jest.fn().mockResolvedValue(true),
  isValidStellarAddress: jest.fn().mockReturnValue(true),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
    default: {
      placeBet: jest.fn().mockResolvedValue(undefined),
      ensureInitialized: jest.fn(),
      getActiveRound: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../lib/redis", () => ({
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  invalidateLeaderboardSortedSet: jest.fn().mockResolvedValue(undefined),
  getCacheMetrics: jest.fn().mockReturnValue({ enabled: false }),
}));

// Mock rate limiters to avoid 429 during load tests
jest.mock("../middleware/rateLimiter.middleware", () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Mock Prisma to keep tests lightweight and avoid DB dependency
jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: "perf-user-id",
        walletAddress:
          "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
        role: "USER",
      }),
    },
    authChallenge: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({
        id: "ch-1",
        challenge: "xelma_auth_perf",
        expiresAt: new Date(),
      }),
    },
    round: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({
        id: "some-uuid",
        status: "ACTIVE",
        mode: "UP_DOWN",
      }),
    },
    prediction: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "idem-1" }),
      upsert: jest.fn().mockResolvedValue({ id: "idem-1" }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    mockRound: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "btc-updown-live",
          asset: "BTC",
          mode: "updown",
          status: "live",
          startPrice: 60000,
          poolUp: 0,
          poolDown: 0,
          closesAt: new Date(Date.now() + 300_000).toISOString(),
        },
      ]),
    },
    mockLeaderboard: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    mockPlatformStat: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((cb) =>
      cb({
        round: {
          findUnique: jest.fn().mockResolvedValue({
            id: "some-uuid",
            status: "ACTIVE",
            mode: "UP_DOWN",
            startTime: new Date(),
            endTime: new Date(Date.now() + 60_000),
            startPrice: 0.1,
            endPrice: null,
            poolUp: 0,
            poolDown: 0,
            priceRanges: [],
            resolvedAt: null,
          }),
          update: jest.fn().mockResolvedValue({
            id: "some-uuid",
            status: "ACTIVE",
            mode: "UP_DOWN",
            startTime: new Date(),
            endTime: new Date(Date.now() + 60_000),
            startPrice: 0.1,
            endPrice: null,
            poolUp: 10,
            poolDown: 0,
            priceRanges: [],
            resolvedAt: null,
          }),
        },
        prediction: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(({ data }: any) =>
            Promise.resolve({
              id: `pred-${data.roundId}`,
              ...data,
              createdAt: new Date(),
            })
          ),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: "perf-user-id",
            walletAddress:
              "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
            role: "USER",
            virtualBalance: 1000,
          }),
          update: jest.fn().mockResolvedValue({
            id: "perf-user-id",
            walletAddress:
              "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX",
            role: "USER",
            virtualBalance: 990,
          }),
        },
        outboxEvent: {
          create: jest.fn().mockResolvedValue({ id: "outbox-1" }),
        },
      })
    ),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const LOAD_CONFIG = getLoadTestConfig();
const WALLET =
  "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";
const BET_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function waitForConnect(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for socket connect")),
      timeoutMs
    );

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForRoomJoined(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for room:joined")),
      timeoutMs
    );

    socket.once("room:joined", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("Performance Baseline Checks (#152)", () => {
  let app: Express;
  let validToken: string;

  beforeAll(() => {
    app = createApp();
    validToken = generateToken("perf-user-id", WALLET, UserRole.USER);
  });

  const measureLatency = async (
    method: "get" | "post",
    path: string,
    body?: any,
    token?: string
  ): Promise<number> => {
    const start = Date.now();
    const req = request(app)[method](path);
    if (token) req.set("Authorization", `Bearer ${token}`);
    if (body) req.send(body);
    await req;
    return Date.now() - start;
  };

  it(`POST /api/auth/challenge should respond within ${LOAD_CONFIG.baseline.challengeLatencyMs}ms`, async () => {
    const latency = await measureLatency("post", "/api/auth/challenge", {
      walletAddress: WALLET,
    });
    console.log(`[PERF] /api/auth/challenge latency: ${latency}ms`);
    expect(latency).toBeLessThan(LOAD_CONFIG.baseline.challengeLatencyMs);
  });

  it(`GET /api/rounds/active should respond within ${LOAD_CONFIG.baseline.activeRoundsLatencyMs}ms`, async () => {
    const latency = await measureLatency("get", "/api/rounds/active");
    console.log(`[PERF] /api/rounds/active latency: ${latency}ms`);
    expect(latency).toBeLessThan(LOAD_CONFIG.baseline.activeRoundsLatencyMs);
  });

  it(`POST /api/predictions/submit should respond within ${LOAD_CONFIG.baseline.submitPredictionLatencyMs}ms`, async () => {
    const latency = await measureLatency(
      "post",
      "/api/predictions/submit",
      {
        roundId: "some-uuid",
        amount: 10,
        side: "UP",
      },
      validToken
    );
    console.log(`[PERF] /api/predictions/submit latency: ${latency}ms`);
    expect(latency).toBeLessThan(LOAD_CONFIG.baseline.submitPredictionLatencyMs);
  });
});

describe("Load Test Harness — Prediction Throughput (#21)", () => {
  let app: Express;
  let validToken: string;

  beforeAll(() => {
    app = createApp();
    validToken = generateToken("perf-user-id", WALLET, UserRole.USER);
  });

  it("sustains concurrent prediction submissions with measurable throughput", async () => {
    const { concurrency, iterations, minThroughputRps, maxP95LatencyMs } =
      LOAD_CONFIG.prediction;

    const result = await runConcurrentLoad({
      concurrency,
      iterations,
      task: async (index) => {
        const startedAt = Date.now();
        const response = await request(app)
          .post("/api/predictions/submit")
          .set("Authorization", `Bearer ${validToken}`)
          .send({
            roundId: `perf-round-${index}`,
            amount: 10,
            side: "UP",
          });

        return {
          success: response.status === 200,
          latencyMs: Date.now() - startedAt,
          statusCode: response.status,
        };
      },
    });

    console.log(formatLoadTestReport("prediction throughput", result));

    expect(result.errorRate).toBeLessThanOrEqual(LOAD_CONFIG.prediction.maxErrorRate);
    expect(result.throughputRps).toBeGreaterThanOrEqual(minThroughputRps);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(maxP95LatencyMs);
  });
});

describe("Load Test Harness — Authenticated bets (#500)", () => {
  let app: Express;
  let betToken: string;
  const previousStubMode = process.env.BET_STUB_MODE;

  beforeAll(() => {
    process.env.BET_STUB_MODE = "true";
    app = createApp();
    betToken = generateToken("perf-user-id", BET_WALLET, UserRole.USER);
  });

  afterAll(() => {
    process.env.BET_STUB_MODE = previousStubMode;
  });

  it("sustains concurrent authenticated UP/DOWN bets with measurable p95", async () => {
    const { concurrency, iterations, minThroughputRps, maxP95LatencyMs, maxErrorRate } =
      LOAD_CONFIG.authBet;

    const result = await runConcurrentLoad({
      concurrency,
      iterations,
      task: async (index) => {
        const startedAt = Date.now();
        const response = await request(app)
          .post("/api/bets/up-down")
          .set("Authorization", `Bearer ${betToken}`)
          .send({
            address: BET_WALLET,
            amount: 1 + (index % 5),
            side: index % 2 === 0 ? "UP" : "DOWN",
          });

        return {
          success: response.status === 200,
          latencyMs: Date.now() - startedAt,
          statusCode: response.status,
        };
      },
    });

    console.log(formatLoadTestReport("auth bet throughput", result));

    expect(result.errorRate).toBeLessThanOrEqual(maxErrorRate);
    expect(result.throughputRps).toBeGreaterThanOrEqual(minThroughputRps);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(maxP95LatencyMs);
  });
});

describe("Load Test Harness — Duplicate idempotency (#500)", () => {
  let app: Express;
  let betToken: string;
  const previousStubMode = process.env.BET_STUB_MODE;

  beforeAll(() => {
    process.env.BET_STUB_MODE = "true";
    app = createApp();
    betToken = generateToken("perf-user-id", BET_WALLET, UserRole.USER);
  });

  afterAll(() => {
    process.env.BET_STUB_MODE = previousStubMode;
  });

  it("replays the same Idempotency-Key without creating extra bets", async () => {
    const { concurrency, iterations, maxP95LatencyMs, maxErrorRate } =
      LOAD_CONFIG.idempotency;
    const idempotencyKey = `load-idempotency-${Date.now()}`;
    const beforeCount = (await betStore.getBets({ address: BET_WALLET })).length;

    const result = await runConcurrentLoad({
      concurrency,
      iterations,
      task: async () => {
        const startedAt = Date.now();
        const response = await request(app)
          .post("/api/bets/up-down")
          .set("Authorization", `Bearer ${betToken}`)
          .set("Idempotency-Key", idempotencyKey)
          .send({
            address: BET_WALLET,
            amount: 10,
            side: "UP",
          });

        return {
          success: response.status === 200 || response.status === 409,
          latencyMs: Date.now() - startedAt,
          statusCode: response.status,
        };
      },
    });

    console.log(formatLoadTestReport("duplicate idempotency", result));

    const created = (await betStore.getBets({ address: BET_WALLET })).length - beforeCount;
    expect(created).toBe(1);
    expect(result.errorRate).toBeLessThanOrEqual(maxErrorRate);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(maxP95LatencyMs);
  });
});

describe("Load Test Harness — Read rounds (#500)", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it("sustains concurrent GET /api/rounds/active with measurable p95", async () => {
    const { concurrency, iterations, minThroughputRps, maxP95LatencyMs, maxErrorRate } =
      LOAD_CONFIG.readRounds;

    const result = await runConcurrentLoad({
      concurrency,
      iterations,
      task: async () => {
        const startedAt = Date.now();
        const response = await request(app).get("/api/rounds/active");

        return {
          success: response.status === 200,
          latencyMs: Date.now() - startedAt,
          statusCode: response.status,
        };
      },
    });

    console.log(formatLoadTestReport("read rounds throughput", result));

    expect(result.errorRate).toBeLessThanOrEqual(maxErrorRate);
    expect(result.throughputRps).toBeGreaterThanOrEqual(minThroughputRps);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(maxP95LatencyMs);
  });
});

describe("Load Test Harness — WebSocket Fanout (#21)", () => {
  let httpServer: HttpServer;
  let baseURL: string;
  const clients: Socket[] = [];

  beforeAll(async () => {
    const app = createApp();
    httpServer = createServer(app);
    await initializeSocket(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        const port =
          typeof address === "object" && address ? address.port : 0;
        baseURL = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }, 15000);

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    }
  }, 15000);

  it("delivers round gameplay events to all subscribed clients", async () => {
    const { clientCount, minDeliveryRate, maxP95FanoutMs } =
      LOAD_CONFIG.websocket;

    for (let index = 0; index < clientCount; index += 1) {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);
      client.emit("join:round");
      await waitForRoomJoined(client);
      clients.push(client);
    }

    const fanout = await measureWebSocketFanout({
      clients,
      eventName: WebSocketEvents.PredictionPlaced,
      emit: () => {
        websocketService.emitPredictionPlaced(
          {
            id: "perf-prediction",
            amount: 25,
            side: "UP",
            priceRange: null,
          },
          "perf-round"
        );
      },
    });

    console.log(formatFanoutReport("websocket fanout", fanout));

    expect(fanout.deliveredCount).toBe(clientCount);
    expect(fanout.deliveryRate).toBeGreaterThanOrEqual(minDeliveryRate);
    expect(fanout.fanoutMs.p95).toBeLessThanOrEqual(maxP95FanoutMs);
  });
});
