import { describe, it, expect, afterEach } from "@jest/globals";

const originalEnv = process.env;

function setEnv(overrides: Record<string, string | undefined>): void {
  process.env = { ...originalEnv, ...overrides };
}

function restoreEnv(): void {
  process.env = originalEnv;
}

describe("parseOriginList", () => {
  const { parseOriginList } = require("../utils/cors");

  it("returns an empty array for undefined, null, or empty input", () => {
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList(null)).toEqual([]);
    expect(parseOriginList("")).toEqual([]);
  });

  it("splits a comma-separated list", () => {
    expect(parseOriginList("https://a.example.com,https://b.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("trims surrounding whitespace on each entry", () => {
    expect(
      parseOriginList(" https://a.example.com , https://b.example.com "),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("drops blank tokens from empty segments and trailing commas", () => {
    expect(
      parseOriginList("https://a.example.com,,  ,https://b.example.com,"),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("returns a single-element array for one origin", () => {
    expect(parseOriginList("https://only.example.com")).toEqual([
      "https://only.example.com",
    ]);
  });
});

describe("getSocketCorsConfig", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("returns origins, methods, and credentials", () => {
    setEnv({
      NODE_ENV: "production",
      CLIENT_URL: "https://app.example.com",
    });
    jest.resetModules();
    const { getSocketCorsConfig } = require("../utils/cors");
    const config = getSocketCorsConfig();
    expect(config).toEqual({
      origin: "https://app.example.com",
      methods: ["GET", "POST"],
      credentials: true,
    });
  });
});

describe("CORS single source of truth", () => {
  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it("resolves the same function reference for HTTP and Socket.IO", () => {
    jest.resetModules();
    const { getCorsOrigins } = require("../utils/cors");
    const { getCorsOrigins: socketGetCorsOrigins } = require("../socket");
    const { getHttpCorsOrigins } = require("../utils/cors");

    expect(socketGetCorsOrigins).toBe(getCorsOrigins);
    expect(getHttpCorsOrigins).toBe(getCorsOrigins);
  });

  const scenarios: Array<{ name: string; env: Record<string, string | undefined> }> = [
    {
      name: "production with a single origin",
      env: { NODE_ENV: "production", CLIENT_URL: "https://app.example.com", ALLOWED_ORIGINS: undefined },
    },
    {
      name: "production with additional origins",
      env: {
        NODE_ENV: "production",
        CLIENT_URL: "https://app.example.com",
        ALLOWED_ORIGINS: "https://staging.example.com,https://dev.example.com",
      },
    },
    {
      name: "development with CLIENT_URL set",
      env: { NODE_ENV: "development", CLIENT_URL: "http://localhost:5173", ALLOWED_ORIGINS: undefined },
    },
    {
      name: "development with CLIENT_URL unset",
      env: { NODE_ENV: "development", CLIENT_URL: undefined, ALLOWED_ORIGINS: undefined },
    },
  ];

  it.each(scenarios)("HTTP and Socket.IO agree: $name", ({ env }) => {
    setEnv({ JWT_SECRET: "test-secret", DATABASE_URL: "postgresql://test:test@localhost:5432/test", ...env });
    jest.resetModules();

    const { getHttpCorsOrigins } = require("../utils/cors");
    const { getCorsOrigins: socketGetCorsOrigins } = require("../socket");

    expect(socketGetCorsOrigins()).toEqual(getHttpCorsOrigins());
  });
});
