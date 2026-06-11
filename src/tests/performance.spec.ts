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
  },
}));

jest.mock("../lib/redis", () => ({
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
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
      findUnique: jest.fn().mockResolvedValue({
        id: "some-uuid",
        status: "ACTIVE",
        mode: "UP_DOWN",
      }),
    },
    prediction: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((cb) =>
      cb({
        round: {
          findUnique: jest.fn().mockResolvedValue({
            id: "some-uuid",
            status: "ACTIVE",
            mode: "UP_DOWN",
          }),
          update: jest.fn().mockResolvedValue({}),
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
      })
    ),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

const LOAD_CONFIG = getLoadTestConfig();
const WALLET =
  "GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX";

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

    expect(result.successes).toBe(iterations);
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
