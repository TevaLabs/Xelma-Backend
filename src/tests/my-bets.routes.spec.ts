import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { UserRole } from "@prisma/client";
import request from "supertest";
import { Express } from "express";

const USER_A_ID = "my-bets-user-a";
const USER_B_ID = "my-bets-user-b";
const USER_EMPTY_ID = "my-bets-user-empty";
const mockUserFindUnique = jest.fn();
const mockBetFindMany = jest.fn();
const mockBetCount = jest.fn();

jest.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...args: any[]) => mockUserFindUnique(...args) },
    bet: {
      findMany: (...args: any[]) => mockBetFindMany(...args),
      count: (...args: any[]) => mockBetCount(...args),
    },
  },
}));

import { createApp } from "../index";
import { generateToken } from "../utils/jwt.util";

const baseDate = new Date("2026-09-01T12:00:00.000Z");
const fixtureBets = [
  { id: "a-1", userId: USER_A_ID, createdAt: new Date(baseDate.getTime() - 3000) },
  { id: "a-2", userId: USER_A_ID, createdAt: new Date(baseDate.getTime() - 1000) },
  { id: "a-3", userId: USER_A_ID, createdAt: new Date(baseDate.getTime() - 1000) },
  { id: "a-4", userId: USER_A_ID, createdAt: baseDate },
  { id: "b-1", userId: USER_B_ID, createdAt: baseDate },
].map((fixture) => ({
  ...fixture,
  status: "CONFIRMED",
  txHash: fixture.id === "a-1" ? null : `tx-${fixture.id}`,
  roundId: "round-1",
  amount: "10.25000000",
  mode: "UP_DOWN",
  side: "UP",
  predictedPrice: null,
  updatedAt: fixture.createdAt,
  submittedAt: fixture.createdAt,
  confirmedAt: fixture.createdAt,
  resolvedAt: null,
  failedAt: null,
  failureReason: "must not leak",
}));

describe("GET /api/bets", () => {
  let app: Express;
  let tokenA: string;
  let tokenB: string;
  let emptyToken: string;

  beforeAll(() => {
    app = createApp();
    tokenA = generateToken(USER_A_ID, "GUSER_A_____________________________________", UserRole.USER);
    tokenB = generateToken(USER_B_ID, "GUSER_B_____________________________________", UserRole.USER);
    emptyToken = generateToken(USER_EMPTY_ID, "GUSER_EMPTY_________________________________", UserRole.USER);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockImplementation(async (args: any) => ({
      id: args.where.id,
      walletAddress: `G${args.where.id}`,
      role: UserRole.USER,
    }));
    mockBetFindMany.mockImplementation(async (args: any) =>
      fixtureBets
        .filter((bet) => bet.userId === args.where.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(args.skip, args.skip + args.take),
    );
    mockBetCount.mockImplementation(async (args: any) =>
      fixtureBets.filter((bet) => bet.userId === args.where.userId).length,
    );
  });

  it("requires authentication", async () => {
    const response = await request(app).get("/api/bets");
    expect(response.status).toBe(401);
    const invalidTokenResponse = await request(app)
      .get("/api/bets")
      .set("Authorization", "Bearer invalid-token");
    expect(invalidTokenResponse.status).toBe(401);
    expect(mockBetFindMany).not.toHaveBeenCalled();
  });

  it("returns only the authenticated user's bets, newest first with stable ordering", async () => {
    const response = await request(app)
      .get(`/api/bets?limit=2&userId=${USER_B_ID}`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(response.status).toBe(200);
    expect(response.body.data.map((bet: any) => bet.id)).toEqual(["a-4", "a-3"]);
    expect(response.body.data.every((bet: any) => bet.userId === undefined)).toBe(true);
    expect(mockBetFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: USER_A_ID },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
      skip: 0,
    }));
  });

  it("isolates user B from user A's bets", async () => {
    const response = await request(app)
      .get("/api/bets")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(response.status).toBe(200);
    expect(response.body.data.map((bet: any) => bet.id)).toEqual(["b-1"]);
    expect(mockBetFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_B_ID } }));
  });

  it("paginates without overlap and returns the shared pagination metadata", async () => {
    const pageOne = await request(app)
      .get("/api/bets?limit=2&offset=0")
      .set("Authorization", `Bearer ${tokenA}`);
    const pageTwo = await request(app)
      .get("/api/bets?limit=2&offset=2")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(pageOne.body.data.map((bet: any) => bet.id)).toEqual(["a-4", "a-3"]);
    expect(pageTwo.body.data.map((bet: any) => bet.id)).toEqual(["a-2", "a-1"]);
    expect(pageOne.body.data.some((bet: any) => pageTwo.body.data.some((next: any) => next.id === bet.id))).toBe(false);
    expect(pageOne.body.meta.pagination).toEqual({ limit: 2, offset: 0, total: 4, hasNextPage: true });
    expect(pageTwo.body.meta.pagination).toEqual({ limit: 2, offset: 2, total: 4, hasNextPage: false });
  });

  it("returns an empty page with valid metadata for a user without bets", async () => {
    const response = await request(app)
      .get("/api/bets")
      .set("Authorization", `Bearer ${emptyToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.pagination).toEqual({ limit: 20, offset: 0, total: 0, hasNextPage: false });
  });

  it("serializes the public bet fields and money as a decimal string", async () => {
    const response = await request(app)
      .get("/api/bets")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      id: "a-4",
      state: "CONFIRMED",
      txHash: "tx-a-4",
      roundId: "round-1",
      amount: "10.25000000",
      createdAt: baseDate.toISOString(),
    });
    expect(typeof response.body.data[0].amount).toBe("string");
    expect(response.body.data[0].failureReason).toBeUndefined();
  });

  it("rejects invalid pagination values and enforces the maximum limit", async () => {
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=abc"]) {
      const response = await request(app)
        .get(`/api/bets?${query}`)
        .set("Authorization", `Bearer ${tokenA}`);
      expect(response.status).toBe(400);
    }
  });
});
