/**
 * Issue #371 — the tournament a client lists must be the tournament it can join.
 * Both runtime modes are exercised through the HTTP surface with a mocked
 * Prisma client, so no live database is required.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import { UserRole } from "@prisma/client";

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

const mockUserFindUnique = jest.fn();
const mockTournamentCount = jest.fn();
const mockTournamentFindMany = jest.fn();
const mockTournamentFindUnique = jest.fn();
const mockTournamentUpdate = jest.fn();
const mockParticipantFindUnique = jest.fn();
const mockParticipantCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    tournament: {
      count: (...args: unknown[]) => mockTournamentCount(...args),
      findMany: (...args: unknown[]) => mockTournamentFindMany(...args),
      findUnique: (...args: unknown[]) => mockTournamentFindUnique(...args),
      update: (...args: unknown[]) => mockTournamentUpdate(...args),
    },
    tournamentParticipant: {
      findUnique: (...args: unknown[]) => mockParticipantFindUnique(...args),
      create: (...args: unknown[]) => mockParticipantCreate(...args),
    },
    tournamentWaitlist: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { createApp } from "../app";
import { generateToken } from "../utils/jwt.util";
import {
  MOCK_TOURNAMENTS,
  resetTournamentDataSource,
} from "../services/tournament.service";

const USER_ID = "list-join-user";
const WALLET = "GB2IKI5ONW2CQBD7WX4I76B5V65KQNEEVBLFYSYPC4IMHENDNBR5AYUN";
const TOKEN = generateToken(USER_ID, WALLET, UserRole.USER);

const app = createApp();

function mockAuthenticatedUser(): void {
  mockUserFindUnique.mockResolvedValue({
    id: USER_ID,
    walletAddress: WALLET,
    role: UserRole.USER,
  });
}

function dbTournamentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "db-1",
    name: "DB Cup",
    description: "from prisma",
    mode: "UP_DOWN",
    status: "UPCOMING",
    entryFee: { toString: () => "5" },
    prizePool: { toString: () => "50" },
    maxParticipants: 10,
    currentParticipants: 1,
    startTime: new Date("2026-07-01T00:00:00Z"),
    endTime: new Date("2026-07-02T00:00:00Z"),
    rounds: 3,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("Tournament list -> join coherence (#371)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTournamentDataSource();
  });

  describe("mock mode", () => {
    beforeEach(() => {
      process.env.TOURNAMENTS_SOURCE = "mock";
    });

    it("joins a tournament id that came from the list response", async () => {
      const listRes = await request(app).get("/api/tournaments?status=UPCOMING");
      expect(listRes.status).toBe(200);
      const listed = listRes.body.data[0];
      expect(listed.id).toBe("t-002");

      mockAuthenticatedUser();
      const joinRes = await request(app)
        .post(`/api/tournaments/${listed.id}/join`)
        .set("Authorization", `Bearer ${TOKEN}`);

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.data).toMatchObject({
        tournamentId: "t-002",
        status: "CONFIRMED",
        currentParticipants: 13,
      });
      // The mock store is shared: the next list reflects the join.
      const afterRes = await request(app).get("/api/tournaments?status=UPCOMING");
      expect(afterRes.body.data[0].currentParticipants).toBe(13);
      expect(MOCK_TOURNAMENTS.find((t) => t.id === "t-002")?.currentParticipants).toBe(
        13,
      );
      expect(mockTournamentFindUnique).not.toHaveBeenCalled();
    });

    it("rejects a duplicate join from the same mock store", async () => {
      mockAuthenticatedUser();
      const headers = { Authorization: `Bearer ${TOKEN}` };

      const first = await request(app)
        .post("/api/tournaments/t-002/join")
        .set(headers);
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/api/tournaments/t-002/join")
        .set(headers);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("CONFLICT");
    });
  });

  describe("DB mode", () => {
    beforeEach(() => {
      process.env.TOURNAMENTS_SOURCE = "prisma";
    });

    it("joins a Prisma-listed id through the same Prisma store", async () => {
      mockTournamentCount.mockResolvedValue(1);
      mockTournamentFindMany.mockResolvedValue([dbTournamentRow()]);
      mockAuthenticatedUser();

      const listRes = await request(app).get("/api/tournaments");
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      const listedId = listRes.body.data[0].id;
      expect(listedId).toBe("db-1");

      mockTournamentFindUnique.mockResolvedValue(dbTournamentRow());
      mockParticipantFindUnique.mockResolvedValue(null);
      mockTournamentUpdate.mockResolvedValue(dbTournamentRow({ currentParticipants: 2 }));
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          $queryRaw: jest.fn(),
          tournament: {
            findUnique: jest.fn().mockResolvedValue(dbTournamentRow()),
            update: mockTournamentUpdate,
          },
          tournamentParticipant: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: mockParticipantCreate,
          },
          tournamentWaitlist: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        };
        return fn(tx);
      });

      const joinRes = await request(app)
        .post(`/api/tournaments/${listedId}/join`)
        .set("Authorization", `Bearer ${TOKEN}`);

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.data).toMatchObject({
        tournamentId: "db-1",
        status: "CONFIRMED",
        currentParticipants: 2,
      });
      expect(mockTournamentFindUnique).toHaveBeenCalledWith({
        where: { id: "db-1" },
      });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalid query params", () => {
    it("still returns 400 in either source mode", async () => {
      process.env.TOURNAMENTS_SOURCE = "mock";
      const mockRes = await request(app).get("/api/tournaments?mode=NOPE");
      expect(mockRes.status).toBe(400);
      expect(mockRes.body.code).toBe("VALIDATION_ERROR");

      process.env.TOURNAMENTS_SOURCE = "prisma";
      const dbRes = await request(app).get("/api/tournaments?status=NOPE");
      expect(dbRes.status).toBe(400);
      expect(dbRes.body.code).toBe("VALIDATION_ERROR");
    });
  });
});
