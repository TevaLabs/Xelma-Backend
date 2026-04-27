import dotenv from "dotenv";
import { createValidator, ConfigValidationError } from "./validation";

dotenv.config();

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface AppConfig {
  port: number;
  nodeEnv: "development" | "production" | "test";
  clientUrl: string;
  logLevel: string;
}

export interface JwtConfig {
  secret: string;
  expiry: string;
}

export interface DatabaseConfig {
  url: string;
  connectionLimit: number;
  poolTimeoutSeconds: number;
  connectTimeoutSeconds: number;
  statementTimeoutMs: number;
  pgbouncer: boolean;
}

export interface SorobanConfig {
  contractId: string;
  network: "testnet" | "mainnet";
  rpcUrl: string;
  adminSecret: string;
  oracleSecret: string;
}

export interface SchedulerConfig {
  autoResolveEnabled: boolean;
  autoResolveIntervalSeconds: number;
  roundSchedulerEnabled: boolean;
  roundSchedulerMode: "UP_DOWN" | "LEGENDS";
}

export interface StellarConfig {
  network: "testnet" | "mainnet";
}

export interface SocketConfig {
  clientUrl: string;
}

export interface OracleConfig {
  pollingIntervalMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  stalenessThresholdMs: number;
}

export interface Config {
  app: AppConfig;
  jwt: JwtConfig;
  database: DatabaseConfig;
  soroban: SorobanConfig;
  scheduler: SchedulerConfig;
  stellar: StellarConfig;
  socket: SocketConfig;
  oracle: OracleConfig;
}

// ---------------------------------------------------------------------------
// Build & validate
// ---------------------------------------------------------------------------

function buildConfig(): Config {
  const v = createValidator();
  const env = process.env;

  const app: AppConfig = {
    port: v.port(env.PORT, "PORT", 3000),
    nodeEnv: v.oneOf(
      env.NODE_ENV,
      "NODE_ENV",
      ["development", "production", "test"] as const,
      "development",
    ),
    clientUrl: v.optional(env.CLIENT_URL, "*"),
    logLevel: v.oneOf(
      env.LOG_LEVEL,
      "LOG_LEVEL",
      ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const,
      "info",
    ),
  };

  const jwt: JwtConfig = {
    secret: v.sensitiveRequired(env.JWT_SECRET, "JWT_SECRET"),
    expiry: v.optional(env.JWT_EXPIRY, "7d"),
  };

  const database: DatabaseConfig = {
    url: v.required(env.DATABASE_URL, "DATABASE_URL"),
    connectionLimit: v.positiveInt(env.DB_CONNECTION_LIMIT, "DB_CONNECTION_LIMIT", 10),
    poolTimeoutSeconds: v.positiveInt(
      env.DB_POOL_TIMEOUT_SECONDS,
      "DB_POOL_TIMEOUT_SECONDS",
      10,
    ),
    connectTimeoutSeconds: v.positiveInt(
      env.DB_CONNECT_TIMEOUT_SECONDS,
      "DB_CONNECT_TIMEOUT_SECONDS",
      10,
    ),
    statementTimeoutMs: v.nonNegativeInt(
      env.DB_STATEMENT_TIMEOUT_MS,
      "DB_STATEMENT_TIMEOUT_MS",
      0,
      { max: 60 * 60 * 1000 },
    ),
    pgbouncer: v.boolean(env.DB_PGBOUNCER, false),
  };

  // Merge pool/timeout settings into the connection string as Prisma/pg expects.
  // If DATABASE_URL already includes any of these params, explicit env vars win.
  try {
    const url = new URL(database.url);

    const setParam = (key: string, value: string) => {
      url.searchParams.set(key, value);
    };

    setParam("connection_limit", String(database.connectionLimit));
    setParam("pool_timeout", String(database.poolTimeoutSeconds));
    setParam("connect_timeout", String(database.connectTimeoutSeconds));
    if (database.statementTimeoutMs > 0) {
      setParam("statement_timeout", String(database.statementTimeoutMs));
    } else {
      url.searchParams.delete("statement_timeout");
    }
    if (database.pgbouncer) {
      setParam("pgbouncer", "true");
    } else {
      url.searchParams.delete("pgbouncer");
    }

    database.url = url.toString();
  } catch {
    // Keep existing validator behavior: DATABASE_URL required but not strongly URL-validated here.
    // Prisma will surface a clear error if the URL is malformed.
  }

  const sorobanNetwork = v.oneOf(
    env.SOROBAN_NETWORK,
    "SOROBAN_NETWORK",
    ["testnet", "mainnet"] as const,
    "testnet",
  );

  const soroban: SorobanConfig = {
    contractId: v.optional(env.SOROBAN_CONTRACT_ID, ""),
    network: sorobanNetwork,
    rpcUrl: v.url(
      env.SOROBAN_RPC_URL,
      "SOROBAN_RPC_URL",
      "https://soroban-testnet.stellar.org",
    ),
    adminSecret: v.optional(env.SOROBAN_ADMIN_SECRET, ""),
    oracleSecret: v.optional(env.SOROBAN_ORACLE_SECRET, ""),
  };

  const scheduler: SchedulerConfig = {
    autoResolveEnabled: v.boolean(env.AUTO_RESOLVE_ENABLED, false),
    autoResolveIntervalSeconds: v.positiveInt(
      env.AUTO_RESOLVE_INTERVAL_SECONDS,
      "AUTO_RESOLVE_INTERVAL_SECONDS",
      30,
    ),
    roundSchedulerEnabled: v.boolean(env.ROUND_SCHEDULER_ENABLED, false),
    roundSchedulerMode: v.oneOf(
      env.ROUND_SCHEDULER_MODE,
      "ROUND_SCHEDULER_MODE",
      ["UP_DOWN", "LEGENDS"] as const,
      "UP_DOWN",
    ),
  };

  const stellar: StellarConfig = {
    network: v.oneOf(
      env.STELLAR_NETWORK,
      "STELLAR_NETWORK",
      ["testnet", "mainnet"] as const,
      "testnet",
    ),
  };

  const socket: SocketConfig = {
    clientUrl: app.clientUrl,
  };

  const oracle: OracleConfig = {
    pollingIntervalMs: v.positiveInt(
      env.ORACLE_POLLING_INTERVAL_MS,
      "ORACLE_POLLING_INTERVAL_MS",
      10000,
    ),
    requestTimeoutMs: v.positiveInt(
      env.ORACLE_REQUEST_TIMEOUT_MS,
      "ORACLE_REQUEST_TIMEOUT_MS",
      5000,
    ),
    maxRetries: v.nonNegativeInt(
      env.ORACLE_MAX_RETRIES,
      "ORACLE_MAX_RETRIES",
      3,
    ),
    stalenessThresholdMs: v.positiveInt(
      env.ORACLE_STALENESS_THRESHOLD_MS,
      "ORACLE_STALENESS_THRESHOLD_MS",
      60000,
    ),
  };

  // Fail fast — surface every invalid field at once
  v.throwIfErrors();

  return { app, jwt, database, soroban, scheduler, stellar, socket, oracle };
}

// ---------------------------------------------------------------------------
// Singleton export — parsed and validated once at module load time.
// Any import of this module triggers validation; if it fails the process
// logs every error and exits with code 1.
// ---------------------------------------------------------------------------

let _config: Config;

try {
  _config = buildConfig();
} catch (err) {
  if (err instanceof ConfigValidationError) {
    // In normal runtime we fail fast and exit the process.
    // In Jest/test environments we throw so tests can assert on the failure.
    const isTestEnv =
      process.env.NODE_ENV === "test" || Boolean(process.env.JEST_WORKER_ID);
    if (!isTestEnv) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  throw err;
}

const config: Readonly<Config> = Object.freeze(_config);
export default config;
