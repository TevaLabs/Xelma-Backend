/**
 * Socket.IO auth and room event tests (Issue #78).
 * Uses mocked Prisma so tests pass without DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer, Server as HttpServer } from "http";
import { io as ioClient, Socket } from "socket.io-client";
import { createApp } from "../index";
import { initializeSocket } from "../socket";
import { generateToken } from "../utils/jwt.util";

const SOCKET_USER_ID = "socket-test-user-id";
const mockUserFindUnique = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
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

describe("Socket.IO Auth & Room Events (Issue #78)", () => {
  let httpServer: HttpServer;
  let baseURL: string;
  let testUser: { id: string; walletAddress: string };
  let validToken: string;

  beforeAll(async () => {
    testUser = {
      id: SOCKET_USER_ID,
      walletAddress: "GSOCKET_TEST_USER___________________________",
    };
    validToken = generateToken(testUser.id, testUser.walletAddress);

    mockUserFindUnique.mockResolvedValue({
      id: testUser.id,
      walletAddress: testUser.walletAddress,
    });

    const app = createApp();
    httpServer = createServer(app);
    initializeSocket(httpServer);

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
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    jest.clearAllMocks();
  });

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
});
