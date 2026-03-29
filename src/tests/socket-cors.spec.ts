/**
 * Tests for Socket.IO CORS configuration (Issue #106).
 * 
 * Note: These tests mock process.env before importing the socket module
 * because getCorsOrigins reads env vars at module load time.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const originalEnv = process.env;

function setEnv(overrides: Record<string, string | undefined>): void {
  process.env = { ...originalEnv, ...overrides };
}

function restoreEnv(): void {
  process.env = originalEnv;
}

describe("getCorsOrigins", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("should throw in production when CLIENT_URL is not set", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: undefined,
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    expect(() => getCorsOrigins()).toThrow("CLIENT_URL environment variable is required in production");
  });

  it("should return CLIENT_URL in production when set", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    expect(getCorsOrigins()).toBe("https://app.example.com");
  });

  it("should support multiple origins in production via ALLOWED_ORIGINS", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com,https://dev.example.com",
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    const origins = getCorsOrigins();
    expect(origins).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
      "https://dev.example.com",
    ]);
  });

  it("should return wildcard in development when CLIENT_URL is not set", () => {
    setEnv({
      NODE_ENV: "development",
      CLIENT_URL: undefined,
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    expect(getCorsOrigins()).toBe("*");
  });

  it("should return CLIENT_URL in development when set", () => {
    setEnv({
      NODE_ENV: "development",
      CLIENT_URL: "http://localhost:5173",
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    expect(getCorsOrigins()).toBe("http://localhost:5173");
  });

  it("should return single origin string (not array) for single origin", () => {
    setEnv({
      NODE_ENV: "development",
      CLIENT_URL: "https://app.example.com",
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    const result = getCorsOrigins();
    expect(typeof result).toBe("string");
    expect(result).toBe("https://app.example.com");
  });

  it("should handle ALLOWED_ORIGINS with extra whitespace", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: " https://staging.example.com , https://dev.example.com ",
      JWT_SECRET: "test-secret",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    });
    jest.resetModules();

    const { getCorsOrigins } = require("../socket");
    const origins = getCorsOrigins();
    expect(origins).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
      "https://dev.example.com",
    ]);
  });
});
