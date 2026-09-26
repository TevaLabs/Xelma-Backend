import dotenv from "dotenv";
import { createValidator, ConfigValidationError } from "./validation";
import { resolveSorobanEnvVars } from "./env";
import logger from "../utils/logger";

dotenv.config();

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export type SafetyProfile = "production" | "demo";

export interface AppConfig {
  port: number;
  nodeEnv: "development" | "production" | "test";
  clientUrl: string;
  logLevel: string;
  apiOnly: boolean;
  roundsMockMode: boolean;
  dataMode: "mock" | "live";
  dataStore: "memory" | "postgres";
  enableSimulation: boolean;
  enableMultiplayerSocial: boolean;
  metricsScrapeToken: string;
  /** Lightweight Socket.IO without Prisma chat/session (hackathon demos). */
  socketDemoMode: boolean;
  /**
   * Safety profile controlling money-path guardrails.
   * "production" — fail-closed: BET_STUB_MODE forbidden, Soroban secrets required.
   * "demo"       — fail-open: stub mode allowed, secrets optional.
   */
  safetyProfile: SafetyProfile;
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
  /**
   * When true, money paths (bet/resolve) abort if Soroban chain verification
   * fails. When false (default), demos may proceed with DB-only fallback.
   * Production should set SOROBAN_FAIL_CLOSED=true.
   */
  failClosed: boolean;
  /** Consecutive RPC failures before the Soroban circuit breaker opens. */
  breakerFailureThreshold: number;
  /** How long the Soroban circuit breaker stays open before a half-open probe. */
  breakerOpenBackoffMs: number;
  /** Max concurrent Soroban RPC calls; extras are rejected with 503. */
  moneyPathMaxInFlight: number;
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
  coinGeckoUrl: string;
  coinCapUrl: string;
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

  const safetyProfile: SafetyProfile = v.oneOf(
    env.SAFETY_PROFILE,
    "SAFETY_PROFILE",
    ["production", "demo"] as const,
    "demo",
  );

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
    apiOnly: v.boolean(env.API_ONLY, false),
    roundsMockMode: v.boolean(env.ROUNDS_MOCK_MODE, false),
    dataMode: v.oneOf(env.DATA_MODE, "DATA_MODE", ["mock", "live"] as const, "live"),
    dataStore: v.oneOf(
      env.DATA_STORE ?? (env.DATA_MODE === "mock" ? "memory" : undefined),
      "DATA_STORE",
      ["memory", "postgres"] as const,
      "postgres",
    ),
    enableSimulation: v.boolean(env.ENABLE_SIMULATION, false),
    enableMultiplayerSocial: v.boolean(env.ENABLE_MULTIPLAYER_SOCIAL, true),
    metricsScrapeToken: v.optional(env.METRICS_SCRAPE_TOKEN, ""),
    socketDemoMode: v.boolean(
      env.SOCKET_DEMO_MODE ??
        (env.DATA_STORE === "memory" || env.DATA_MODE === "mock"
          ? "true"
          : undefined),
      false,
    ),
    safetyProfile,
  };

  const jwt: JwtConfig = {
    secret: v.sensitiveRequired(env.JWT_SECRET, "JWT_SECRET"),
    expiry: v.optional(env.JWT_EXPIRY, "7d"),
  };

  const isMockMode = env.DATA_MODE === "mock";

  const database: DatabaseConfig = {
    url: isMockMode
      ? v.optional(env.DATABASE_URL, "postgresql://mock:mock@localhost:5432/mock")
      : v.required(env.DATABASE_URL, "DATABASE_URL"),
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
  // Skip URL merging in mock mode when no real database is used.
  if (!isMockMode || env.DATABASE_URL) {
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
  }

  // Prefer SOROBAN_* canonically; accept CONTRACT_ID / STELLAR_RPC_URL aliases (#404).
  const sorobanEnv = resolveSorobanEnvVars(env);

  const sorobanNetwork = v.oneOf(
    sorobanEnv.network,
    "SOROBAN_NETWORK",
    ["testnet", "mainnet"] as const,
    "testnet",
  );

  const soroban: SorobanConfig = {
    contractId: v.optional(sorobanEnv.contractId.value, ""),
    network: sorobanNetwork,
    rpcUrl: v.url(
      sorobanEnv.rpcUrl.value,
      sorobanEnv.rpcUrl.source ?? "SOROBAN_RPC_URL",
      "https://soroban-testnet.stellar.org",
    ),
    adminSecret: v.optional(sorobanEnv.adminSecret, ""),
    oracleSecret: v.optional(sorobanEnv.oracleSecret, ""),
    // Default fail-open for local/demo; production should set true.
    failClosed: v.boolean(env.SOROBAN_FAIL_CLOSED, false),
    breakerFailureThreshold: v.positiveInt(
      env.SOROBAN_BREAKER_FAILURE_THRESHOLD,
      "SOROBAN_BREAKER_FAILURE_THRESHOLD",
      3,
    ),
    breakerOpenBackoffMs: v.positiveInt(
      env.SOROBAN_BREAKER_OPEN_BACKOFF_MS,
      "SOROBAN_BREAKER_OPEN_BACKOFF_MS",
      30_000,
    ),
    moneyPathMaxInFlight: v.positiveInt(
      env.SOROBAN_MONEY_PATH_MAX_IN_FLIGHT,
      "SOROBAN_MONEY_PATH_MAX_IN_FLIGHT",
      8,
    ),
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
    coinGeckoUrl: v.optional(
      env.COINGECKO_API_URL,
      "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
    ),
    coinCapUrl: v.optional(
      env.COINCAP_API_URL,
      "https://api.coincap.io/v2/assets/stellar",
    ),
  };

  // Cross-field invariant (#229): the staleness threshold must exceed the
  // polling interval, otherwise a freshly-fetched price is immediately
  // classified as stale and round resolution would never run.
  v.assert(
    oracle.stalenessThresholdMs > oracle.pollingIntervalMs,
    `ORACLE_STALENESS_THRESHOLD_MS (${oracle.stalenessThresholdMs}) must be greater than ` +
      `ORACLE_POLLING_INTERVAL_MS (${oracle.pollingIntervalMs}); otherwise the price is ` +
      `considered stale immediately after every poll.`,
  );

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
      logger.error("Config validation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
    throw err;
  }
  throw err;
}

const config: Readonly<Config> = Object.freeze(_config);
export default config;
