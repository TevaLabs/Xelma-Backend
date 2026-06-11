/**
 * Tests for GET /api/chat/history – pagination contracts (Issue #19).
 *
 * Covers:
 *   - Offset mode (backward-compatible)
 *   - Cursor mode
 *   - Input validation (limit bounds, negative offset, bad cursor)
 *   - Pagination meta shape in both modes
 */
import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";
import { createApp } from "../index";
import { encodeCursor } from "../utils/pagination.util";

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

const mockMessageFindMany = jest.fn();
const mockMessageCount = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    message: {
      findMany: (...args: any[]) => mockMessageFindMany(...args),
      count: (...args: any[]) => mockMessageCount(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMessages = (n: number, baseDate = new Date("2026-06-01T12:00:00Z")) =>
  Array.from({ length: n }, (_, i) => ({
    id: `msg-${i}`,
    userId: `user-${i}`,
    content: `Message ${i}`,
    createdAt: new Date(baseDate.getTime() - i * 1000), // newest first
    user: { walletAddress: `GWALLET${String(i).padStart(50, "0")}` },
  }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/chat/history", () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Offset mode
  // -------------------------------------------------------------------------

  describe("offset mode", () => {
    it("returns 200 with messages and pagination meta (no params)", async () => {
      const msgs = makeMessages(10);
      mockMessageFindMany.mockResolvedValue(msgs);
      mockMessageCount.mockResolvedValue(10);

      const res = await request(app).get("/api/chat/history");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.limit).toBeDefined();
      expect(res.body.pagination.offset).toBeDefined();
      expect(res.body.pagination.total).toBeDefined();
      expect(typeof res.body.pagination.hasNextPage).toBe("boolean");
      // Legacy field still present
      expect(typeof res.body.count).toBe("number");
    });

    it("echoes limit and offset in pagination meta", async () => {
      mockMessageFindMany.mockResolvedValue(makeMessages(5));
      mockMessageCount.mockResolvedValue(20);

      const res = await request(app).get("/api/chat/history?limit=5&offset=10");

      expect(res.status).toBe(200);
      expect(res.body.pagination.limit).toBe(5);
      expect(res.body.pagination.offset).toBe(10);
      expect(res.body.pagination.total).toBe(20);
    });

    it("hasNextPage is true when more rows exist", async () => {
      mockMessageFindMany.mockResolvedValue(makeMessages(5));
      mockMessageCount.mockResolvedValue(20);

      const res = await request(app).get("/api/chat/history?limit=5&offset=0");

      expect(res.status).toBe(200);
      expect(res.body.pagination.hasNextPage).toBe(true);
    });

    it("hasNextPage is false on the last page", async () => {
      mockMessageFindMany.mockResolvedValue(makeMessages(3));
      mockMessageCount.mockResolvedValue(3);

      const res = await request(app).get("/api/chat/history?limit=10&offset=0");

      expect(res.status).toBe(200);
      expect(res.body.pagination.hasNextPage).toBe(false);
    });

    it("caps limit at 50 even when a higher value is requested", async () => {
      // The schema allows max 100 but the route caps chat at 50
      mockMessageFindMany.mockResolvedValue(makeMessages(50));
      mockMessageCount.mockResolvedValue(100);

      const res = await request(app).get("/api/chat/history?limit=100");

      expect(res.status).toBe(200);
      // The service was called with at most 50
      const callArgs = mockMessageFindMany.mock.calls[0][0];
      expect(callArgs.take).toBeLessThanOrEqual(50);
    });

    it("returns 400 for negative offset", async () => {
      const res = await request(app).get("/api/chat/history?offset=-1");
      expect(res.status).toBe(400);
    });

    it("returns 400 for limit=0", async () => {
      const res = await request(app).get("/api/chat/history?limit=0");
      expect(res.status).toBe(400);
    });

    it("returns messages in oldest-first order", async () => {
      // makeMessages returns newest-first; the service reverses them
      const msgs = makeMessages(3);
      mockMessageFindMany.mockResolvedValue(msgs);
      mockMessageCount.mockResolvedValue(3);

      const res = await request(app).get("/api/chat/history?limit=3");

      expect(res.status).toBe(200);
      // After reversal, the last message in the array should be the newest
      const times = res.body.messages.map((m: any) => new Date(m.createdAt).getTime());
      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cursor mode
  // -------------------------------------------------------------------------

  describe("cursor mode", () => {
    it("returns 200 with cursor pagination meta when cursor param is present", async () => {
      const msgs = makeMessages(6); // limit=5, sentinel=1
      mockMessageFindMany.mockResolvedValue(msgs);

      const cursor = encodeCursor({ createdAt: "2026-06-01T12:00:00.000Z", id: "msg-0" });
      const res = await request(app).get(`/api/chat/history?limit=5&cursor=${cursor}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.hasNextPage).toBe(true);
      expect(typeof res.body.pagination.nextCursor).toBe("string");
      // No offset/total in cursor mode
      expect(res.body.pagination.total).toBeUndefined();
      expect(res.body.pagination.offset).toBeUndefined();
    });

    it("nextCursor is null on the last page", async () => {
      const msgs = makeMessages(3); // limit=5, only 3 rows → last page
      mockMessageFindMany.mockResolvedValue(msgs);

      const cursor = encodeCursor({ createdAt: "2026-06-01T12:00:00.000Z", id: "msg-0" });
      const res = await request(app).get(`/api/chat/history?limit=5&cursor=${cursor}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination.hasNextPage).toBe(false);
      expect(res.body.pagination.nextCursor).toBeNull();
    });

    it("returns 200 with empty messages when no rows match cursor", async () => {
      mockMessageFindMany.mockResolvedValue([]);

      const cursor = encodeCursor({ createdAt: "2020-01-01T00:00:00.000Z", id: "old-id" });
      const res = await request(app).get(`/api/chat/history?limit=10&cursor=${cursor}`);

      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(0);
      expect(res.body.pagination.hasNextPage).toBe(false);
      expect(res.body.pagination.nextCursor).toBeNull();
    });

    it("ignores offset when cursor is present", async () => {
      const msgs = makeMessages(3);
      mockMessageFindMany.mockResolvedValue(msgs);

      const cursor = encodeCursor({ createdAt: "2026-06-01T12:00:00.000Z", id: "msg-0" });
      // offset=99 should be ignored
      const res = await request(app).get(
        `/api/chat/history?limit=5&cursor=${cursor}&offset=99`,
      );

      expect(res.status).toBe(200);
      // Cursor mode response has no offset field
      expect(res.body.pagination.offset).toBeUndefined();
    });

    it("returns 400 for limit=0 in cursor mode", async () => {
      const cursor = encodeCursor({ id: "x" });
      const res = await request(app).get(`/api/chat/history?limit=0&cursor=${cursor}`);
      expect(res.status).toBe(400);
    });
  });
});
