/**
 * Regression coverage for #192 — the resolved HTTP CORS allowlist that
 * /api/admin/cors-diagnostics returns to operators. The diagnostics
 * endpoint is a thin wrapper over getHttpCorsOrigins(), so locking the
 * resolver's behavior here pins what operators will see.
 *
 * Mirrors the pattern in socket-cors.spec.ts.
 */
import { describe, it, expect, afterEach } from "@jest/globals";

const originalEnv = process.env;

function setEnv(overrides: Record<string, string | undefined>): void {
  process.env = { ...originalEnv, ...overrides };
}

function restoreEnv(): void {
  process.env = originalEnv;
}

describe("getHttpCorsOrigins", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("throws in production when CLIENT_URL is not set", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: undefined,
      ALLOWED_ORIGINS: undefined,
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../utils/cors");
    expect(() => getHttpCorsOrigins()).toThrow(
      /CLIENT_URL environment variable is required in production/,
    );
  });

  it("returns CLIENT_URL alone in production", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: undefined,
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../utils/cors");
    expect(getHttpCorsOrigins()).toBe("https://app.example.com");
  });

  it("merges ALLOWED_ORIGINS in production", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://staging.example.com,https://dev.example.com",
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../utils/cors");
    expect(getHttpCorsOrigins()).toEqual([
      "https://app.example.com",
      "https://staging.example.com",
      "https://dev.example.com",
    ]);
  });

  it("returns true (allow-all) in development when CLIENT_URL unset", () => {
    setEnv({
      NODE_ENV: "development",
      CLIENT_URL: undefined,
      ALLOWED_ORIGINS: undefined,
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../utils/cors");
    expect(getHttpCorsOrigins()).toBe(true);
  });

  it("filters blank tokens out of ALLOWED_ORIGINS", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
      ALLOWED_ORIGINS: "https://a.example.com,,  ,https://b.example.com",
    });
    jest.resetModules();
    const { getHttpCorsOrigins } = require("../utils/cors");
    expect(getHttpCorsOrigins()).toEqual([
      "https://app.example.com",
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

// #708 — credentials must never be true when the origin is a wildcard
describe("corsCredentials", () => {
  it("returns false when origins is the wildcard boolean true", () => {
    jest.resetModules();
    const { corsCredentials } = require("../utils/cors");
    expect(corsCredentials(true)).toBe(false);
  });

  it("returns false when origins is the wildcard string '*'", () => {
    jest.resetModules();
    const { corsCredentials } = require("../utils/cors");
    expect(corsCredentials("*")).toBe(false);
  });

  it("returns true for an explicit origin string", () => {
    jest.resetModules();
    const { corsCredentials } = require("../utils/cors");
    expect(corsCredentials("https://app.example.com")).toBe(true);
  });

  it("returns true for an explicit origin array", () => {
    jest.resetModules();
    const { corsCredentials } = require("../utils/cors");
    expect(corsCredentials(["https://app.example.com", "https://staging.example.com"])).toBe(true);
  });

  it("development wildcard (CLIENT_URL unset) disables credentials", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, NODE_ENV: "development", CLIENT_URL: undefined, ALLOWED_ORIGINS: undefined };
    jest.resetModules();
    const { getCorsOrigins, corsCredentials } = require("../utils/cors");
    const origins = getCorsOrigins();
    expect(origins).toBe(true);
    expect(corsCredentials(origins)).toBe(false);
    process.env = originalEnv;
  });

  it("production explicit origin enables credentials", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, NODE_ENV: "production", CLIENT_URL: "https://app.example.com", ALLOWED_ORIGINS: undefined };
    jest.resetModules();
    const { getCorsOrigins, corsCredentials } = require("../utils/cors");
    const origins = getCorsOrigins();
    expect(corsCredentials(origins)).toBe(true);
    process.env = originalEnv;
  });
});
