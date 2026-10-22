import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import request from "supertest";

jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address && address.startsWith("G") && address.length === 56),
  verifySignature: jest.fn(),
}));

jest.mock("../services/soroban.service", () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

const mockCount = jest.fn();
const mockFindMany = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    tournament: {
      count: (...args: unknown[]) => mockCount(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    tournamentParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { createApp } from "../app";
import tournamentService, {
  filterTournaments,
  MOCK_TOURNAMENTS,
} from "../services/tournament.service";

describe("Tournament listing (#378)", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TOURNAMENTS_SOURCE;
  });

  describe("filterTournaments helper", () => {
    it("filters by mode only", () => {
      const result = filterTournaments(MOCK_TOURNAMENTS, { mode: "UP_DOWN" });
      expect(result.every((t) => t.mode === "UP_DOWN")).toBe(true);
      expect(result.length).toBe(2);
    });

    it("filters by status only", () => {
      const result = filterTournaments(MOCK_TOURNAMENTS, { status: "ACTIVE" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t-001");
    });

    it("filters by mode and status together", () => {
      const result = filterTournaments(MOCK_TOURNAMENTS, {
        mode: "UP_DOWN",
        status: "COMPLETED",
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("t-003");
    });
  });

  describe("GET /api/tournaments", () => {
    it("returns paginated list with stable pagination shape", async () => {
      const res = await request(app).get("/api/tournaments?limit=10&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta.pagination).toEqual({
        limit: 10,
        offset: 0,
        total: expect.any(Number),
        hasNextPage: false,
        totalPages: 1,
      });
      expect(res.body.meta.pagination.total).toBe(MOCK_TOURNAMENTS.length);
    });

    it("filters by mode=UP_DOWN", async () => {
      const res = await request(app).get("/api/tournaments?mode=UP_DOWN");
      expect(res.status).toBe(200);
      expect(res.body.data.every((t: any) => t.mode === "UP_DOWN")).toBe(true);
      expect(res.body.meta.pagination.total).toBe(2);
    });

    it("filters by mode=LEGENDS", async () => {
      const res = await request(app).get("/api/tournaments?mode=LEGENDS");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].mode).toBe("LEGENDS");
      expect(res.body.meta.pagination.total).toBe(1);
    });

    it("filters by status=ACTIVE", async () => {
      const res = await request(app).get("/api/tournaments?status=ACTIVE");
      expect(res.status).toBe(200);
      expect(res.body.data.every((t: any) => t.status === "ACTIVE")).toBe(true);
      expect(res.body.meta.pagination.total).toBe(1);
    });

    it("supports mode + status together", async () => {
      const res = await request(app).get(
        "/api/tournaments?mode=UP_DOWN&status=COMPLETED",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: "t-003",
        mode: "UP_DOWN",
        status: "COMPLETED",
      });
      expect(res.body.meta.pagination).toEqual({
        limit: 20,
        offset: 0,
        total: 1,
        hasNextPage: false,
        totalPages: 1,
      });
    });

    it("returns 400 for invalid mode", async () => {
      const res = await request(app).get("/api/tournaments?mode=INVALID");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app).get("/api/tournaments?status=NOPE");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("applies limit/offset consistently after filtering", async () => {
      const res = await request(app).get(
        "/api/tournaments?mode=UP_DOWN&limit=1&offset=1",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.pagination).toEqual({
        limit: 1,
        offset: 1,
        total: 2,
        hasNextPage: false,
        totalPages: 2,
      });
      // Second UP_DOWN tournament after offset 1
      expect(res.body.data[0].id).toBe("t-003");
    });
  });

  describe("listFromPrisma", () => {
    it("passes mode and status into Prisma where and paginates", async () => {
      mockCount.mockResolvedValue(1);
      mockFindMany.mockResolvedValue([
        {
          id: "db-1",
          name: "DB Cup",
          description: "from db",
          mode: "LEGENDS",
          status: "ACTIVE",
          entryFee: { toString: () => "5" },
          prizePool: { toString: () => "50" },
          maxParticipants: 10,
          currentParticipants: 2,
          startTime: new Date("2026-07-01T00:00:00Z"),
          endTime: new Date("2026-07-02T00:00:00Z"),
          rounds: 3,
          createdAt: new Date("2026-06-01T00:00:00Z"),
        },
      ]);

      const page = await tournamentService.listTournaments(
        { limit: 10, offset: 0, mode: "LEGENDS", status: "ACTIVE" },
        "prisma",
      );

      expect(mockCount).toHaveBeenCalledWith({
        where: { mode: "LEGENDS", status: "ACTIVE" },
      });
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { mode: "LEGENDS", status: "ACTIVE" },
          skip: 0,
          take: 10,
        }),
      );
      expect(page.pagination).toEqual({ limit: 10, offset: 0, total: 1 });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        id: "db-1",
        mode: "LEGENDS",
        status: "ACTIVE",
        entryFee: "5.00000000",
        prizePool: "50.00000000",
      });
    });
  });
});
