import { describe, it, expect, afterEach } from "@jest/globals";
import request from "supertest";
import { Express } from "express";

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk
// (which contains ESM files that Jest fails to parse).
jest.mock("../services/stellar.service", () => ({
  isValidStellarAddress: (address: string) =>
    address && address.startsWith("G") && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock("../services/soroban.service", () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn(),
    getPendingWinnings: jest.fn(),
    getHealth: jest.fn(),
    init: jest.fn(),
  },
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

const originalEducationFlag = process.env.ENABLE_EDUCATION;

const resetEducationFlag = () => {
  if (originalEducationFlag === undefined) {
    delete process.env.ENABLE_EDUCATION;
  } else {
    process.env.ENABLE_EDUCATION = originalEducationFlag;
  }
};

describe("hackathon education feature flag (#532)", () => {
  afterEach(() => {
    resetEducationFlag();
    jest.resetModules();
  });

  it("does not mount education routes by default (404)", async () => {
    const { createApp } = await import("../app");
    const app: Express = createApp();

    const res = await request(app).get("/api/education/guides");

    expect(res.status).toBe(404);
  });

  it("does not mount education routes when ENABLE_EDUCATION=false", async () => {
    process.env.ENABLE_EDUCATION = "false";
    jest.resetModules();

    const { createApp } = await import("../app");
    const app: Express = createApp();

    const res = await request(app).get("/api/education/guides");

    expect(res.status).toBe(404);
  });

  it("mounts education routes when ENABLE_EDUCATION=true", async () => {
    process.env.ENABLE_EDUCATION = "true";
    jest.resetModules();

    const { createApp } = await import("../app");
    const app: Express = createApp();

    const res = await request(app).get("/api/education/guides");

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.guides)).toBe(true);
    expect(res.body.categories).toBeDefined();
    expect(Array.isArray(res.body.categories.volatility)).toBe(true);
  });

  it("keeps the tip route reachable (returns a typed error without a resolved round)", async () => {
    process.env.ENABLE_EDUCATION = "true";
    jest.resetModules();

    const { createApp } = await import("../app");
    const app: Express = createApp();

    // With the routes mounted, /tip must be handled by the education router
    // (400 for a missing roundId) rather than falling through to 404.
    const res = await request(app).get("/api/education/tip");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("never mounts education on the hackathon app via the per-call override", async () => {
    process.env.ENABLE_EDUCATION = "true";
    jest.resetModules();

    const { createApp } = await import("../app");
    const app: Express = createApp({ features: { education: false } });

    const res = await request(app).get("/api/education/guides");

    expect(res.status).toBe(404);
  });
});
