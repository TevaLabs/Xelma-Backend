/**
 * Socket.IO auth, room event, chat:send, and heartbeat/reconnect tests.
 * Uses mocked Prisma and chatService so tests pass without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { createServer, Server as HttpServer } from "http";
import { io as ioClient, Socket } from "socket.io-client";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "../index";
import {
  initializeSocket,
  chatRateLimiter,
  connectionRegistry,
  checkStaleConnections,
  PING_INTERVAL,
  PING_TIMEOUT,
} from "../socket";
import { generateToken } from "../utils/jwt.util";

const SOCKET_USER_ID = "socket-test-user-id";
const SOCKET_WALLET = "GSOCKET_TEST_USER___________________________";

const mockUserFindUnique = jest.fn();
const mockChatSendMessage = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/chat.service", () => ({
  __esModule: true,
  default: {
    sendMessage: (...args: any[]) => mockChatSendMessage(...args),
    getHistory: jest.fn().mockResolvedValue([]),
  },
}));

function waitFor(socket: Socket, event: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: any) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function waitForConnect(socket: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for connect")), timeoutMs);
    if (socket.connected) {
      clearTimeout(t);
      return resolve();
    }
    socket.once("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitForDisconnect(socket: Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for disconnect")), timeoutMs);
    socket.once("disconnect", (reason: string) => {
      clearTimeout(t);
      resolve(reason);
    });
  });
}

/** Emit chat:send and return the ack payload. */
function sendChat(socket: Socket, content: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for chat:send ack")), timeoutMs);
    socket.emit("chat:send", { content }, (ack: any) => {
      clearTimeout(t);
      resolve(ack);
    });
  });
}

describe("Socket.IO Auth & Room Events (Issue #78)", () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let baseURL: string;
  let testUser: { id: string; walletAddress: string };
  let validToken: string;

  beforeAll(async () => {
    testUser = { id: SOCKET_USER_ID, walletAddress: SOCKET_WALLET };
    validToken = generateToken(testUser.id, testUser.walletAddress);

    mockUserFindUnique.mockResolvedValue({
      id: testUser.id,
      walletAddress: testUser.walletAddress,
    });

    const app = createApp();
    httpServer = createServer(app);
    io = initializeSocket(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseURL = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    }
    jest.clearAllMocks();
  }, 15000);

  describe("Socket auth", () => {
    it("should allow connection without token (unauthenticated)", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);
      expect(client.connected).toBe(true);
      client.disconnect();
    });

    it("should reject connection with invalid token", async () => {
      const client = ioClient(baseURL, {
        auth: { token: "invalid.jwt.token" },
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await expect(waitForConnect(client)).rejects.toBeDefined();
      client.disconnect();
    });

    it("should accept connection with valid JWT and attach user", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);
      expect(client.connected).toBe(true);
      client.disconnect();
    });
  });

  describe("Room events", () => {
    it("should emit room:joined when joining round room", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);

      const joined = waitFor(client, "room:joined");
      client.emit("join:round");

      const data = await joined;
      expect(data).toEqual({ room: "round" });

      client.disconnect();
    });

    it("should emit room:left when leaving round room", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);
      client.emit("join:round");
      await waitFor(client, "room:joined");

      const left = waitFor(client, "room:left");
      client.emit("leave:round");

      const data = await left;
      expect(data).toEqual({ room: "round" });

      client.disconnect();
    });

    it("should allow authenticated user to join chat and emit room:joined", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);

      const joined = waitFor(client, "room:joined");
      client.emit("join:chat");

      const data = await joined;
      expect(data).toEqual({ room: "chat" });

      client.disconnect();
    });

    it("should emit error when unauthenticated user tries to join chat", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);

      const errMsg = waitFor(client, "error");
      client.emit("join:chat");

      const data = await errMsg;
      expect(data.message).toContain("Authentication required");

      client.disconnect();
    });

    it("should allow authenticated user to join notifications room", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);

      const joined = waitFor(client, "room:joined");
      client.emit("join:notifications");

      const data = await joined;
      expect(data).toEqual({ room: "notifications" });

      client.disconnect();
    });

    it("should emit error when unauthenticated user tries join:notifications", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      client.connect();
      await waitForConnect(client);

      const errMsg = waitFor(client, "error");
      client.emit("join:notifications");

      const data = await errMsg;
      expect(data.message).toContain("Authentication required");

      client.disconnect();
    });
  });

  describe("chat:send", () => {
    beforeEach(() => {
      chatRateLimiter.reset();
      mockChatSendMessage.mockReset();
    });

    it("should return AUTH_REQUIRED when unauthenticated socket sends chat:send", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      const ack = await sendChat(client, "hello");

      expect(ack).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
      expect(mockChatSendMessage).not.toHaveBeenCalled();

      client.disconnect();
    });

    it("should return INVALID_CONTENT for empty message", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      const ack = await sendChat(client, "   ");

      expect(ack).toMatchObject({ ok: false, code: "INVALID_CONTENT" });
      expect(mockChatSendMessage).not.toHaveBeenCalled();

      client.disconnect();
    });

    it("should return INVALID_CONTENT for message exceeding 500 characters", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      const ack = await sendChat(client, "x".repeat(501));

      expect(ack).toMatchObject({ ok: false, code: "INVALID_CONTENT" });
      expect(mockChatSendMessage).not.toHaveBeenCalled();

      client.disconnect();
    });

    it("should return SEND_FAILED when chatService throws", async () => {
      mockChatSendMessage.mockRejectedValueOnce(new Error("DB error"));

      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      const ack = await sendChat(client, "hello");

      expect(ack).toMatchObject({ ok: false, code: "SEND_FAILED" });

      client.disconnect();
    });

    it("should return ok:true with the message on a valid send", async () => {
      const fakeMessage = {
        id: "msg-1",
        userId: SOCKET_USER_ID,
        walletAddress: "GSORC...TEST",
        content: "hello world",
        createdAt: new Date().toISOString(),
      };
      mockChatSendMessage.mockResolvedValueOnce(fakeMessage);

      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      const ack = await sendChat(client, "hello world");

      expect(ack).toMatchObject({ ok: true, message: fakeMessage });
      expect(mockChatSendMessage).toHaveBeenCalledWith(
        SOCKET_USER_ID,
        SOCKET_WALLET,
        "hello world",
      );

      client.disconnect();
    });

    it("should not crash when chat:send is emitted without a callback", async () => {
      mockChatSendMessage.mockResolvedValueOnce({
        id: "msg-2",
        userId: SOCKET_USER_ID,
        walletAddress: "GSORC...TEST",
        content: "no callback",
        createdAt: new Date().toISOString(),
      });

      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      // Fire and forget — no callback, should not throw server-side
      client.emit("chat:send", { content: "no callback" });

      // Give the server a moment to process
      await new Promise((r) => setTimeout(r, 200));
      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it("should throttle after 5 messages in a 60-second window (burst test)", async () => {
      const fakeMessage = {
        id: "msg-burst",
        userId: SOCKET_USER_ID,
        walletAddress: "GSORC...TEST",
        content: "burst",
        createdAt: new Date().toISOString(),
      };
      mockChatSendMessage.mockResolvedValue(fakeMessage);

      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      // First 5 should succeed
      for (let i = 0; i < 5; i++) {
        const ack = await sendChat(client, "burst");
        expect(ack).toMatchObject({ ok: true });
      }

      // 6th should be rate-limited
      const ack6 = await sendChat(client, "burst");
      expect(ack6).toMatchObject({ ok: false, code: "RATE_LIMITED" });

      // chatService should only have been called 5 times
      expect(mockChatSendMessage).toHaveBeenCalledTimes(5);

      client.disconnect();
    });

    it("should allow messages again after rate limit window resets", async () => {
      const fakeMessage = {
        id: "msg-reset",
        userId: SOCKET_USER_ID,
        walletAddress: "GSORC...TEST",
        content: "after reset",
        createdAt: new Date().toISOString(),
      };
      mockChatSendMessage.mockResolvedValue(fakeMessage);

      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });
      client.connect();
      await waitForConnect(client);

      // Exhaust the quota
      for (let i = 0; i < 5; i++) {
        await sendChat(client, "fill");
      }
      const blocked = await sendChat(client, "blocked");
      expect(blocked).toMatchObject({ ok: false, code: "RATE_LIMITED" });

      // Reset the limiter (simulates window expiry)
      chatRateLimiter.reset(SOCKET_USER_ID);

      const ack = await sendChat(client, "after reset");
      expect(ack).toMatchObject({ ok: true });

      client.disconnect();
    });
  });

  describe("Heartbeat and reconnect (Issue #95)", () => {
    it("should emit server:hello with contract on unauthenticated connection", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);

      const data = await helloPromise;
      expect(data).toMatchObject({
        socketId: expect.any(String),
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
        authenticated: false,
      });
      expect(data.userId).toBeUndefined();

      client.disconnect();
    });

    it("should emit server:hello with userId on authenticated connection", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);

      const data = await helloPromise;
      expect(data).toMatchObject({
        socketId: expect.any(String),
        pingInterval: PING_INTERVAL,
        pingTimeout: PING_TIMEOUT,
        authenticated: true,
        userId: SOCKET_USER_ID,
      });

      client.disconnect();
    });

    it("should register the connection in connectionRegistry on connect", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);
      const { socketId } = await helloPromise;

      expect(connectionRegistry.has(socketId)).toBe(true);
      const record = connectionRegistry.get(socketId)!;
      expect(record.userId).toBe(SOCKET_USER_ID);
      expect(record.connectedAt).toBeGreaterThan(0);
      expect(record.lastSeenAt).toBeGreaterThan(0);

      client.disconnect();
    });

    it("should remove the connection from registry on disconnect", async () => {
      const client = ioClient(baseURL, {
        auth: { token: validToken },
        transports: ["websocket"],
        autoConnect: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);
      const { socketId } = await helloPromise;

      expect(connectionRegistry.has(socketId)).toBe(true);

      // Disconnect and give the server a tick to run the event handler.
      const disconnected = waitForDisconnect(client);
      client.disconnect();
      await disconnected;
      await new Promise((r) => setTimeout(r, 50));

      expect(connectionRegistry.has(socketId)).toBe(false);
    });

    it("should update lastSeenAt when the socket emits an event", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);
      const { socketId } = await helloPromise;

      const record = connectionRegistry.get(socketId)!;
      const before = record.lastSeenAt;

      // Small pause so the clock can advance, then emit an event.
      await new Promise((r) => setTimeout(r, 10));
      client.emit("join:round");
      await waitFor(client, "room:joined");

      expect(record.lastSeenAt).toBeGreaterThanOrEqual(before);

      client.disconnect();
    });

    it("should detect and force-disconnect a stale connection", async () => {
      const client = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
        reconnection: false,
      });

      const helloPromise = waitFor(client, "server:hello");
      client.connect();
      await waitForConnect(client);
      const { socketId } = await helloPromise;

      // Artificially age the connection to make it appear stale.
      const record = connectionRegistry.get(socketId)!;
      record.lastSeenAt = 0; // epoch — far beyond any reasonable threshold

      const disconnected = waitForDisconnect(client);
      checkStaleConnections(io); // default threshold ~40 s; Date.now() - 0 >> 40 s
      await disconnected;

      expect(connectionRegistry.has(socketId)).toBe(false);
      client.disconnect(); // no-op if already disconnected
    });

    it("should silently clean up a phantom registry entry for a gone socket", () => {
      const phantomId = "phantom-socket-id";
      connectionRegistry.set(phantomId, {
        userId: "ghost-user",
        connectedAt: 0,
        lastSeenAt: 0,
      });

      // Socket does not exist in io.sockets.sockets → should delete from
      // registry without throwing.
      const removed = checkStaleConnections(io);

      expect(connectionRegistry.has(phantomId)).toBe(false);
      expect(removed).toBeGreaterThanOrEqual(1);
    });

    it("should require explicit room rejoin after a reconnect", async () => {
      // First connection: join round room.
      const client1 = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
        reconnection: false,
      });

      client1.connect();
      await waitForConnect(client1);
      client1.emit("join:round");
      await waitFor(client1, "room:joined");

      const d1 = waitForDisconnect(client1);
      client1.disconnect();
      await d1;

      // Reconnect as a brand-new socket.
      const client2 = ioClient(baseURL, {
        transports: ["websocket"],
        autoConnect: false,
        reconnection: false,
      });

      const hello2 = waitFor(client2, "server:hello");
      client2.connect();
      await waitForConnect(client2);
      const { socketId: socketId2 } = await hello2;

      // New socket must appear in registry.
      expect(connectionRegistry.has(socketId2)).toBe(true);

      // Room membership is NOT preserved — client must rejoin explicitly.
      const rejoined = waitFor(client2, "room:joined");
      client2.emit("join:round");
      const data = await rejoined;
      expect(data).toEqual({ room: "round" });

      client2.disconnect();
    });

    it("should handle rapid disconnect/reconnect without corrupting the registry", async () => {
      const sockets: Socket[] = [];
      const socketIds: string[] = [];

      for (let i = 0; i < 3; i++) {
        const c = ioClient(baseURL, {
          transports: ["websocket"],
          autoConnect: false,
          reconnection: false,
        });
        const hello = waitFor(c, "server:hello");
        c.connect();
        await waitForConnect(c);
        const { socketId } = await hello;
        expect(connectionRegistry.has(socketId)).toBe(true);
        sockets.push(c);
        socketIds.push(socketId);
      }

      // Disconnect all simultaneously and wait.
      const disconnects = sockets.map((c) => waitForDisconnect(c));
      sockets.forEach((c) => c.disconnect());
      await Promise.all(disconnects);
      await new Promise((r) => setTimeout(r, 50));

      // Registry must have no leftover entries for these sockets.
      for (const id of socketIds) {
        expect(connectionRegistry.has(id)).toBe(false);
      }
    });
  });
});
