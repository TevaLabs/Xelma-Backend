import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

function loadFreshConfig() {
  jest.resetModules();
  return require("../config").default as typeof import("../config").default;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("DB pool env config", () => {
  const baseDbUrl =
    "postgresql://user:pass@localhost:5432/xelma_db?schema=public&connection_limit=99&pool_timeout=99";

  beforeEach(() => {
    // Ensure required config vars are present for all tests.
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
    process.env.DATABASE_URL = baseDbUrl;
  });

  afterEach(() => {
    delete process.env.DB_CONNECTION_LIMIT;
    delete process.env.DB_POOL_TIMEOUT_SECONDS;
    delete process.env.DB_CONNECT_TIMEOUT_SECONDS;
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    delete process.env.DB_TX_TIMEOUT_MS;
    delete process.env.DB_TX_MAX_WAIT_MS;
    delete process.env.DB_PGBOUNCER;
  });

  it("transaction timeouts default to Prisma defaults", () => {
    const config = withEnv(
      { DB_TX_TIMEOUT_MS: undefined, DB_TX_MAX_WAIT_MS: undefined },
      () => loadFreshConfig(),
    );
    expect(config.database.transactionTimeoutMs).toBe(5000);
    expect(config.database.transactionMaxWaitMs).toBe(2000);
  });

  it("transaction timeouts are env-driven and reach the Prisma options", () => {
    const opts = withEnv(
      { DB_TX_TIMEOUT_MS: "30000", DB_TX_MAX_WAIT_MS: "8000" },
      () => {
        const config = loadFreshConfig();
        expect(config.database.transactionTimeoutMs).toBe(30000);
        expect(config.database.transactionMaxWaitMs).toBe(8000);
        const ctor = jest.fn();
        jest.doMock("@prisma/client", () => ({ PrismaClient: ctor }));
        delete (global as any).prisma;
        require("../lib/prisma");
        return {
          helper: require("../lib/prisma").getTransactionOptions(),
          ctorArgs: ctor.mock.calls[0]?.[0],
        };
      },
    );
    expect(opts.helper).toEqual({ timeout: 30000, maxWait: 8000 });
    expect(opts.ctorArgs?.transactionOptions).toEqual({ timeout: 30000, maxWait: 8000 });
  });

  it("rejects an invalid DB_TX_TIMEOUT_MS", () => {
    expect(() =>
      withEnv({ DB_TX_TIMEOUT_MS: "abc" }, () => loadFreshConfig()),
    ).toThrow(/DB_TX_TIMEOUT_MS/);
  });

  it("env vars override existing DATABASE_URL query params", () => {
    const config = withEnv(
      {
        DB_CONNECTION_LIMIT: "5",
        DB_POOL_TIMEOUT_SECONDS: "12",
        DB_CONNECT_TIMEOUT_SECONDS: "7",
        DB_STATEMENT_TIMEOUT_MS: "2500",
        DB_PGBOUNCER: "true",
      },
      () => loadFreshConfig(),
    );

    const u = new URL(config.database.url);
    expect(u.searchParams.get("connection_limit")).toBe("5");
    expect(u.searchParams.get("pool_timeout")).toBe("12");
    expect(u.searchParams.get("connect_timeout")).toBe("7");
    expect(u.searchParams.get("statement_timeout")).toBe("2500");
    expect(u.searchParams.get("pgbouncer")).toBe("true");
  });

  it("statement timeout is removed when DB_STATEMENT_TIMEOUT_MS=0", () => {
    const config = withEnv(
      {
        DB_STATEMENT_TIMEOUT_MS: "0",
      },
      () => loadFreshConfig(),
    );

    const u = new URL(config.database.url);
    expect(u.searchParams.get("statement_timeout")).toBeNull();
  });

  it("invalid values fail fast", () => {
    expect(() =>
      withEnv(
        {
          DB_CONNECTION_LIMIT: "not-a-number",
        },
        () => loadFreshConfig(),
      ),
    ).toThrow(/Configuration validation failed/);
  });
});

