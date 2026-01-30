import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";
import request from "supertest";
import express from "express";
import educationRoutes from "../routes/education.routes";
import { prisma } from "../lib/prisma";

// Create test app
const app = express();
app.use(express.json());
app.use("/api/education", educationRoutes);

describe("GET /api/education/tip - Integration Tests", () => {
  let testRoundId: string;
  let unresolvedRoundId: string;

  beforeAll(async () => {
    // Create a resolved test round
    const resolvedRound = await prisma.round.create({
      data: {
        mode: "UP_DOWN",
        status: "RESOLVED",
        startPrice: 1.0,
        endPrice: 1.05,
        startTime: new Date("2024-01-01T00:00:00Z"),
        endTime: new Date("2024-01-01T00:05:00Z"),
      },
    });
    testRoundId = resolvedRound.id;

    // Create an unresolved test round
    const unresolvedRound = await prisma.round.create({
      data: {
        mode: "UP_DOWN",
        status: "ACTIVE",
        startPrice: 1.0,
        endPrice: null,
        startTime: new Date("2024-01-01T00:00:00Z"),
        endTime: new Date("2024-01-01T00:05:00Z"),
      },
    });
    unresolvedRoundId = unresolvedRound.id;
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.round.deleteMany({
      where: {
        id: {
          in: [testRoundId, unresolvedRoundId],
        },
      },
    });
    await prisma.$disconnect();
  });

  describe("Success Cases", () => {
    it("should return 200 and valid tip for resolved round", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: testRoundId })
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body.message).toBeTruthy();
      expect(response.body.category).toMatch(
        /volatility|oracle|stellar|price-action/,
      );
      expect(response.body.roundId).toBe(testRoundId);
      expect(response.body.metadata).toBeDefined();
      expect(response.body.metadata.priceChange).toBeDefined();
      expect(response.body.metadata.priceChangePercent).toBeDefined();
      expect(response.body.metadata.duration).toBeDefined();
      expect(response.body.metadata.outcome).toMatch(/up|down|unchanged/);
    });

    it("should return consistent tip on subsequent requests (caching)", async () => {
      const response1 = await request(app)
        .get("/api/education/tip")
        .query({ roundId: testRoundId })
        .expect(200);

      const response2 = await request(app)
        .get("/api/education/tip")
        .query({ roundId: testRoundId })
        .expect(200);

      expect(response1.body.message).toBe(response2.body.message);
      expect(response1.body.category).toBe(response2.body.category);
    });

    it("should include correct metadata for high volatility", async () => {
      const highVolatilityRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 1.0,
          endPrice: 1.08,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:05:00Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: highVolatilityRound.id })
        .expect(200);

      expect(response.body.metadata.priceChangePercent).toBeGreaterThan(5);
      expect(response.body.metadata.outcome).toBe("up");

      // Cleanup
      await prisma.round.delete({ where: { id: highVolatilityRound.id } });
    });

    it("should handle price decrease correctly", async () => {
      const decreaseRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 1.0,
          endPrice: 0.95,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:05:00Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: decreaseRound.id })
        .expect(200);

      expect(response.body.metadata.priceChange).toBeLessThan(0);
      expect(response.body.metadata.outcome).toBe("down");

      // Cleanup
      await prisma.round.delete({ where: { id: decreaseRound.id } });
    });
  });

  describe("Validation Errors (400)", () => {
    it("should return 400 when roundId is missing", async () => {
      const response = await request(app).get("/api/education/tip").expect(400);

      expect(response.body.error).toBe("Validation Error");
      expect(response.body.message).toContain("roundId");
    });

    it("should return 400 for invalid UUID format", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: "not-a-valid-uuid" })
        .expect(400);

      expect(response.body.error).toBe("Validation Error");
      expect(response.body.message).toContain("UUID");
    });

    it("should return 400 for empty roundId", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: "" })
        .expect(400);

      expect(response.body.error).toBe("Validation Error");
    });
  });

  describe("Not Found Errors (404)", () => {
    it("should return 404 for non-existent round", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: nonExistentId })
        .expect(404);

      expect(response.body.error).toBe("Not Found");
      expect(response.body.message).toBe("Round not found");
    });
  });

  describe("Invalid Round State (422)", () => {
    it("should return 422 for unresolved round", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: unresolvedRoundId })
        .expect(422);

      expect(response.body.error).toBe("Invalid Round State");
      expect(response.body.message).toContain("resolved");
    });

    it("should return 422 for round with missing price data", async () => {
      const incompletRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 0,
          endPrice: null,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:05:00Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: incompletRound.id })
        .expect(422);

      expect(response.body.error).toBe("Invalid Round Data");
      expect(response.body.message).toContain("price data");

      // Cleanup
      await prisma.round.delete({ where: { id: incompletRound.id } });
    });
  });

  describe("Response Format", () => {
    it("should have correct response structure", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: testRoundId })
        .expect(200);

      // Check top-level fields
      expect(response.body).toHaveProperty("message");
      expect(response.body).toHaveProperty("category");
      expect(response.body).toHaveProperty("roundId");
      expect(response.body).toHaveProperty("metadata");

      // Check metadata fields
      expect(response.body.metadata).toHaveProperty("priceChange");
      expect(response.body.metadata).toHaveProperty("priceChangePercent");
      expect(response.body.metadata).toHaveProperty("duration");
      expect(response.body.metadata).toHaveProperty("outcome");

      // Check data types
      expect(typeof response.body.message).toBe("string");
      expect(typeof response.body.category).toBe("string");
      expect(typeof response.body.roundId).toBe("string");
      expect(typeof response.body.metadata.priceChange).toBe("number");
      expect(typeof response.body.metadata.priceChangePercent).toBe("number");
      expect(typeof response.body.metadata.duration).toBe("number");
      expect(typeof response.body.metadata.outcome).toBe("string");
    });

    it("should not contain template placeholders in message", async () => {
      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: testRoundId })
        .expect(200);

      expect(response.body.message).not.toContain("{");
      expect(response.body.message).not.toContain("}");
    });
  });

  describe("Multiple Rounds Variety", () => {
    it("should generate different tips for different rounds", async () => {
      const rounds: string[] = [];
      const tips: string[] = [];

      // Create multiple rounds with different outcomes
      for (let i = 0; i < 5; i++) {
        const round = await prisma.round.create({
          data: {
            mode: "UP_DOWN",
            status: "RESOLVED",
            startPrice: 1.0,
            endPrice: 1.0 + i * 0.01,
            startTime: new Date("2024-01-01T00:00:00Z"),
            endTime: new Date("2024-01-01T00:05:00Z"),
          },
        });
        rounds.push(round.id);

        const response = await request(app)
          .get("/api/education/tip")
          .query({ roundId: round.id })
          .expect(200);

        tips.push(response.body.message);
      }

      // Should have some variety in tips
      const uniqueTips = new Set(tips);
      expect(uniqueTips.size).toBeGreaterThanOrEqual(2);

      // Cleanup
      await prisma.round.deleteMany({
        where: { id: { in: rounds } },
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle unchanged price (0% movement)", async () => {
      const unchangedRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 1.0,
          endPrice: 1.0,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:05:00Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: unchangedRound.id })
        .expect(200);

      expect(response.body.metadata.priceChange).toBe(0);
      expect(response.body.metadata.priceChangePercent).toBe(0);
      expect(response.body.metadata.outcome).toBe("unchanged");

      // Cleanup
      await prisma.round.delete({ where: { id: unchangedRound.id } });
    });

    it("should handle very short duration rounds", async () => {
      const shortRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 1.0,
          endPrice: 1.05,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:00:10Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: shortRound.id })
        .expect(200);

      expect(response.body.metadata.duration).toBe(10);

      // Cleanup
      await prisma.round.delete({ where: { id: shortRound.id } });
    });

    it("should handle extreme price movements", async () => {
      const extremeRound = await prisma.round.create({
        data: {
          mode: "UP_DOWN",
          status: "RESOLVED",
          startPrice: 1.0,
          endPrice: 1.2,
          startTime: new Date("2024-01-01T00:00:00Z"),
          endTime: new Date("2024-01-01T00:05:00Z"),
        },
      });

      const response = await request(app)
        .get("/api/education/tip")
        .query({ roundId: extremeRound.id })
        .expect(200);

      expect(response.body.metadata.priceChangePercent).toBe(20);
      expect(
        Math.abs(response.body.metadata.priceChangePercent),
      ).toBeGreaterThan(10);

      // Cleanup
      await prisma.round.delete({ where: { id: extremeRound.id } });
    });
  });
});
