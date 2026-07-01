import { describe, it, expect, beforeAll } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createApp } from "../app";

describe("Hackathon API Response Envelope", () => {
  let app: express.Application;

  beforeAll(() => {
    app = createApp();
  });

  const expectSuccessEnvelope = (body: any) => {
    expect(body).toHaveProperty("success");
    expect(body).toHaveProperty("data");
    expect(body.success).toBe(true);
  };

  it("GET /api returns success envelope with health data", async () => {
    const res = await request(app).get("/api");

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body);
    expect(res.body.data).toHaveProperty("status");
    expect(res.body.data).toHaveProperty("services");
  });

  it("GET /api/stats returns success envelope with stats data", async () => {
    const res = await request(app).get("/api/stats");

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body);
    expect(res.body.data).toHaveProperty("totalRounds");
    expect(res.body.data).toHaveProperty("totalUsers");
    expect(res.body.data).toHaveProperty("totalBets");
  });

  it("GET /api/rounds returns success envelope with rounds data", async () => {
    const res = await request(app).get("/api/rounds");

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body);
    expect(res.body.data).toHaveProperty("rounds");
  });

  it("GET /api/leaderboard returns success envelope with leaderboard data", async () => {
    const res = await request(app).get("/api/leaderboard");

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body);
    expect(res.body.data).toHaveProperty("leaderboard");
  });

  it("GET /api/prices returns success envelope with price data", async () => {
    const res = await request(app).get("/api/prices");

    expect(res.status).toBe(200);
    expectSuccessEnvelope(res.body);
    expect(res.body.data).toHaveProperty("BTC");
    expect(res.body.data).toHaveProperty("ETH");
    expect(res.body.data).toHaveProperty("XLM");
  });
});
