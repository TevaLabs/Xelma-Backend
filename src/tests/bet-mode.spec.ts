import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

import {
  isBetStubMode,
  hasSorobanSecrets,
  logResolvedBetMode,
} from "../config/bet-mode";
import logger from "../utils/logger";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    SOROBAN_CONTRACT_ID: "CABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
    SOROBAN_ADMIN_SECRET: "SABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
    SOROBAN_ORACLE_SECRET: "OABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
    ...overrides,
  };
}

// ================================================================
// hasSorobanSecrets
// ================================================================

describe("hasSorobanSecrets", () => {
  it("returns ok=true when all secrets are set", () => {
    const env = makeEnv();
    expect(hasSorobanSecrets(env)).toEqual({ ok: true, missing: [] });
  });

  it("returns missing contract id", () => {
    const env = makeEnv({ SOROBAN_CONTRACT_ID: undefined });
    const result = hasSorobanSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("SOROBAN_CONTRACT_ID");
  });

  it("returns missing admin secret", () => {
    const env = makeEnv({ SOROBAN_ADMIN_SECRET: undefined });
    const result = hasSorobanSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("SOROBAN_ADMIN_SECRET");
  });

  it("returns missing oracle secret", () => {
    const env = makeEnv({ SOROBAN_ORACLE_SECRET: undefined });
    const result = hasSorobanSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("SOROBAN_ORACLE_SECRET");
  });

  it("returns all three missing when none set", () => {
    const env = makeEnv({
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    const result = hasSorobanSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      "SOROBAN_CONTRACT_ID",
      "SOROBAN_ADMIN_SECRET",
      "SOROBAN_ORACLE_SECRET",
    ]);
  });

  it("treats whitespace-only values as unset", () => {
    const env = makeEnv({ SOROBAN_CONTRACT_ID: "   " });
    const result = hasSorobanSecrets(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("SOROBAN_CONTRACT_ID");
  });
});

// ================================================================
// isBetStubMode
// ================================================================

describe("isBetStubMode", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---- Explicit BET_STUB_MODE ----

  it("returns true when BET_STUB_MODE=true (even with secrets)", () => {
    const env = makeEnv({ BET_STUB_MODE: "true" });
    expect(isBetStubMode(env)).toBe(true);
  });

  it("returns false when BET_STUB_MODE=false (even without secrets in non-prod)", () => {
    const env = makeEnv({
      BET_STUB_MODE: "false",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    expect(isBetStubMode(env)).toBe(false);
  });

  // ---- Unset BET_STUB_MODE, non-production ----

  it("defaults to stub when unset and secrets are missing (non-production)", () => {
    const env = makeEnv({
      NODE_ENV: "development",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    expect(isBetStubMode(env)).toBe(true);
  });

  it("defaults to on-chain when unset but secrets are present (non-production)", () => {
    const env = makeEnv({
      NODE_ENV: "development",
      // secrets are present by default from makeEnv()
    });
    expect(isBetStubMode(env)).toBe(false);
  });

  it("treats unset NODE_ENV as non-production", () => {
    const env = makeEnv({
      NODE_ENV: undefined,
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    expect(isBetStubMode(env)).toBe(true);
  });

  it("treats NODE_ENV=test as non-production", () => {
    const env = makeEnv({
      NODE_ENV: "test",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    expect(isBetStubMode(env)).toBe(true);
  });

  // ---- Unset BET_STUB_MODE, production ----

  it("returns false in production even without secrets (does NOT silently stub)", () => {
    const env = makeEnv({
      NODE_ENV: "production",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    expect(isBetStubMode(env)).toBe(false);
  });

  it("returns false in production when secrets are present", () => {
    const env = makeEnv({
      NODE_ENV: "production",
    });
    expect(isBetStubMode(env)).toBe(false);
  });

  // ---- Logging ----

  it("logs a warning when defaulting to stub in non-production", () => {
    const env = makeEnv({
      NODE_ENV: "development",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    isBetStubMode(env);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("defaulting to STUB mode"),
      expect.objectContaining({ missing: expect.arrayContaining(["SOROBAN_CONTRACT_ID"]) }),
    );
  });

  it("logs an error in production with missing secrets", () => {
    const env = makeEnv({
      NODE_ENV: "production",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    isBetStubMode(env);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Soroban secrets are missing in production"),
      expect.objectContaining({ missing: expect.arrayContaining(["SOROBAN_CONTRACT_ID"]) }),
    );
  });
});

// ================================================================
// logResolvedBetMode
// ================================================================

describe("logResolvedBetMode", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("logs and returns true when stub mode is resolved", () => {
    const env = makeEnv({
      NODE_ENV: "development",
      SOROBAN_CONTRACT_ID: undefined,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    });
    const result = logResolvedBetMode(env);
    expect(result).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("STUB"),
      expect.objectContaining({ resolved: true }),
    );
  });

  it("logs and returns false when on-chain mode is resolved", () => {
    const env = makeEnv();
    const result = logResolvedBetMode(env);
    expect(result).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("ON-CHAIN"),
      expect.objectContaining({ resolved: false }),
    );
  });
});
