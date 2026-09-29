import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app-factory";

describe("JSON Request Body Limit (Issue #682)", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = { ...originalEnv, JSON_BODY_LIMIT: "1kb" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should reject JSON request bodies exceeding the configured limit with 413 and standard error envelope", async () => {
    const app = createApp();

    // Payload larger than 1kb
    const largeString = "x".repeat(2048);
    const response = await request(app)
      .post("/api/auth/connect")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ walletAddress: largeString }));

    expect(response.status).toBe(413);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toBe("Payload too large");
    expect(response.body).toHaveProperty("code", "PAYLOAD_TOO_LARGE");
    expect(response.body).toHaveProperty("timestamp");
  });

  it("should accept JSON request bodies within the limit", async () => {
    const app = createApp();

    const response = await request(app)
      .post("/api/auth/connect")
      .set("Content-Type", "application/json")
      .send({ walletAddress: "invalid_address" });

    // Should not be 413 (it might fail validation with 400, but request body was accepted)
    expect(response.status).not.toBe(413);
  });
});
